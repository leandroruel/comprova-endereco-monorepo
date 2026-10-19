# ADR-0027: Status e revogação de credenciais

## Status

Aceito (2026-10-19). Dá sequência ao
[ADR-0026](0026-chave-de-assinatura-por-tenant.md), que fechou a identidade
criptográfica por tenant. Até aqui a credencial era imutável e **não havia como
dizer que um veredito deixou de valer** depois da emissão.

## Contexto

A credencial é assinada e devolvida ao cliente; o projeto **não persiste o
documento**. Isso é proposital (ADR-0019/0024): a credencial é autocontida e o
verificador não depende do banco da API. O efeito colateral é que corrigir um
erro, atender a uma contestação (art. 20 LGPD) ou simplesmente retirar um
veredito emitido por engano exigiria reemitir a credencial — o que não resolve
o documento que já está com o cliente.

O passo mínimo é permitir que o **mesmo documento assinado** seja consultado
depois e que o verificador saiba distinguir:

```text
ACTIVE    → o veredito continua valendo
REVOKED   → o emissor retirou o veredito
UNKNOWN   → não foi possível saber (falha fechado)
```

O status é um eixo **separado** da validade temporal (`validFrom`/`validUntil`)
e da integridade criptográfica (`proof`). Misturá-los produziria um verificador
que aceita um documento expirado como se fosse revogado (ou vice-versa).

## Decisão

### 1. Identificador público da credencial

Não existe tabela de credenciais. Para que o cliente e o emissor cheguem ao
mesmo status sem persistir o documento, o `credential_id` é derivado de forma
determinística:

```text
credential_id = base64url(sha256("comprova:credential:v1|<issuer.id>|<validation.id>"))
```

Propriedades exigidas e testadas:

- **estável** para o par (issuer, validation): reemitir a mesma validation
  reusa o mesmo id — e, portanto, o mesmo status;
- **opaco e não sensível**: não é `validation_id`, `subject_id`, `api_key_id`,
  `doc_hmac` nem `evidence_id`, e não revela nenhum deles;
- **não correlacionável entre tenants**: o `issuer.id` entra no hash; dois
  tenants com o mesmo `validation_id` geram ids diferentes;
- **independente da chave de assinatura**: o `issuer.id` não contém o `key_id`
  (ADR-0026), então rotacionar a chave não muda o id;
- **independente do material de evidência**: só usa o id da validation e o
  issuer; a retenção do S3/`evidence` não muda o id.
- 43 caracteres base64url, validados por CHECK no banco e pelo schema da rota.

O documento assinado passa a carregar:

```json
{
  "id": "<issuer.id>/credentials/<credential_id>",
  "credentialStatus": {
    "id": "<issuer.id>/credentials/<credential_id>/status",
    "type": "comprova:CredentialStatus"
  }
}
```

`credentialStatus` é termo da VC Data Model 2.0. O **valor** (`ACTIVE`/`REVOKED`)
não entra no documento: o documento só aponta a URL pública. Isso mantém a
credencial autocontida e evita reemitir a cada mudança de status. A URL e o
`id` são **cobertos pela assinatura**; adulterá-los invalida a prova.

O binding estrutural é verificado pelo `verifyCredential` puro: `id` tem de ser
`<issuer>/credentials/<id de 43 chars>` e `credentialStatus.id` tem de ser
exatamente `<id>/status`. Um documento legado sem esses membros continua
verificável criptograficamente, mas **quem exige status** é
`verifyCredentialFromIssuer` (abaixo), que falha fechado.

### 2. Persistência mínima: `credential_status`

Migration `0032_credential_status.sql`:

| coluna          | papel                                                |
| --------------- | ---------------------------------------------------- |
| `credential_id` | PK — o id público acima                              |
| `tenant_id`     | FK `tenant` — dono; isolamento por RLS               |
| `issuer_scope`  | digest do tenant na URL; casa a leitura pública      |
| `status`        | `ACTIVE` ou `REVOKED` (CHECK)                        |
| `created_at`    | quando a credencial foi registrada                   |
| `revoked_at`    | quando passou a `REVOKED` (`NULL` enquanto `ACTIVE`) |

Restrições e garantias:

- **uma linha por credencial** (PK);
- `CHECK` garante a consistência `ACTIVE ⇔ revoked_at IS NULL` e
  `REVOKED ⇔ revoked_at IS NOT NULL`;
- `CHECK` de formato exige 43 chars base64url em `credential_id` e
  `issuer_scope`;
- **sem FK** para `validation`, `claim`, `claim_evidence`, `evidence` ou
  `subject`: o status precisa sobreviver à retenção do material físico e da
  validation. A única dependência de ciclo de vida é o `tenant`;
- **sem segredo**: nada de chave privada, documento, documento do subject,
  HMAC, S3 URI ou payload de evidência;
- RLS `ENABLE`+`FORCE`, com `tenant_isolation` (leitura/escrita escopadas por
  `app_tenant_id()`) e `public_status_read` (`SELECT USING (true)`) — a tabela só
  tem identificadores públicos e o endpoint de status é público;
- `GRANT SELECT, INSERT, UPDATE` ao `app_user`; **sem `DELETE`**. A revogação é
  monotônica e não é apagada pela retenção;
- trigger `credential_status_guard`: identidade (`credential_id`,
  `tenant_id`, `issuer_scope`, `created_at`) imutável e **qualquer UPDATE de
  uma linha `REVOKED` é recusado**. `REVOKED` é terminal; não há reativação.

Na emissão, a linha `ACTIVE` é inserida **antes** de devolver a credencial. Se o
insert falhar, a emissão falha: uma credencial em circulação sem status seria
inverificável (fail closed). O insert é idempotente (`onConflictDoNothing`) e
confere a identidade da linha existente; reemitir a mesma validation **não**
reativa uma credencial revogada.

### 3. Endpoint público de status

```text
GET /issuers/:scope/credentials/:credentialId/status
```

- fora de `/v1`, **sem API key**;
- resposta `200` com exatamente `{ "status": "ACTIVE" | "REVOKED" }`;
- `404` para credencial desconhecida **naquele escopo**;
- nenhum `tenant_id`, `validation_id`, subject, documento, evidence, chave ou
  timestamp interno;
- rota com `scope` e `credentialId` no formato de 43 chars base64url.

O endpoint é público porque a URL já está no documento assinado e porque o
status é lido por verificadores independentes. A policy `public_status_read`
permite apenas `SELECT`; a escrita continua escopada por RLS.

### 4. Revogação autenticada e monotônica

```text
POST /v1/credentials/:credentialId/revoke
```

- dentro de `/v1`, autenticada por API key; o tenant vem da chave;
- `200 { "status": "REVOKED" }`, inclusive em chamadas repetidas
  (idempotência);
- `404` para credencial inexistente **ou de outro tenant** — não há distinção
  que revele a existência;
- **não existe** rota de reativação. A única transição é `ACTIVE → REVOKED`.

Concorrência: a atualização casa `WHERE status = 'ACTIVE'`; o row lock serializa
duas revogações e a segunda encontra 0 linhas, mas a leitura seguinte devolve
`REVOKED`. O trigger é a barreira final contra `REVOKED → ACTIVE`.

### 5. Comportamento do verificador

`verifyCredentialFromIssuer` resolve, nesta ordem:

1. forma e `verificationMethod` (como antes, ADR-0025/0026);
2. assinatura e binding estrutural do status (`verifyCredential`);
3. **só então** o status público, via `statusResolver` injetado.

Resultados:

| status resolvido              | resultado                                        |
| ----------------------------- | ------------------------------------------------ |
| `ACTIVE`                      | `{ valid: true }`                                |
| `REVOKED`                     | `{ valid: false, reason: 'STATUS_REVOKED' }`     |
| ausente / erro / desconhecido | `{ valid: false, reason: 'STATUS_UNAVAILABLE' }` |

A verificação é **fail closed**:

- sem `statusResolver`, uma credencial com `credentialStatus` é
  `STATUS_UNAVAILABLE` — nunca `ACTIVE` por omissão;
- resolver que lança (rede/HTTP) ou devolve algo fora de `ACTIVE`/`REVOKED`
  também é `STATUS_UNAVAILABLE`;
- o status é resolvido **depois** da assinatura: um documento adulterado não
  provoca busca;
- o verificador não recebe chave privada, banco, Redis, S3, Temporal nem API
  interna. Recebe o método público, a credencial e o resolver HTTP.

O `verifyCredential` puro continua **sem rede** e não resolve status; ele apenas
valida a assinatura e o binding `id ↔ credentialStatus.id`.

O resolver HTTP concreto
(`makeHttpCredentialStatusResolver`) exige HTTPS, origem na allowlist, URL sem
query/fragmento/credenciais, path exato
`/issuers/<scope>/credentials/<id>/status`, sem redirect, e um documento
estritamente `{ "status": "ACTIVE" | "REVOKED" }`.

### 6. Relação com a retenção

- `credential_status` não tem FK para o material físico nem para a validation;
  apagar `evidence`/`claim_evidence` (retenção) **não** apaga nem altera o
  status.
- A retenção existente não foi alterada: não há purge desta tabela neste passo,
  e o status não é "limpo" junto com a validation. O prazo de guarda do status
  é uma decisão operacional futura; hoje ele persiste enquanto o tenant existir.
- O status é independente da janela temporal da credencial: uma credencial
  expirada pode estar `ACTIVE`; um consumidor que exija ambas as checagens
  aplica a política temporal separadamente.

### 7. Por que não StatusList2021/Merkle/blockchain agora

- **StatusList2021** exigiria publicar e versionar uma lista assinada, com
  atualização, cache e privacidade de correlação — infraestrutura e semântica
  bem maiores do que "uma linha por credencial".
- **Merkle tree/hash chain/event sourcing** resolveria prova de inclusão e
  histórico, mas o problema atual é binário (`ACTIVE`/`REVOKED`) para um volume
  pequeno; a complexidade não se paga.
- **Blockchain** traz custódia, custo, latência e irreversibilidade sem resolver
  o requisito de isolamento por tenant.
- Um **registry genérico de credenciais** reintroduziria o que a arquitetura
  evitou: persistir o documento e acoplar o verificador ao banco do emissor.

Este passo é deliberadamente o menor possível: um id determinístico, uma linha
por credencial, um endpoint público de leitura e uma revogação autenticada.

## Compatibilidade e impacto

- **Nova migração** (`0032`) e tabela `credential_status`.
- **Novo membro no VC**: `id` e `credentialStatus` (opcionais na leitura para
  compatibilidade; obrigatórios na verificação com resolução).
- **Novas rotas**: `GET /issuers/:scope/credentials/:credentialId/status` e
  `POST /v1/credentials/:credentialId/revoke`.
- **Mudança de contrato no verificador**: `verifyCredentialFromIssuer` agora
  exige `statusResolver` para aceitar credenciais atuais; sem ele o resultado é
  `STATUS_UNAVAILABLE`. `verifyCredential` permanece puro.
- **Nenhuma mudança** em `validation`, `claim`, `claim_evidence`, `evidence`,
  `building_key`/`unit_key`, scoring, checkers, policy, T0/T1/T2, retenção,
  `subject.doc_hmac` ou no fluxo de contestação.

## Itens deliberadamente NÃO implementados

DID/DID Document; wallet, VP, selective disclosure, SD-JWT, BBS+; KMS/HSM;
rotação automática de chave; blockchain; Merkle tree; TSA/RFC 3161; event
sourcing/hash-chain; registry genérico; múltiplos tipos de status; status list
complexa; tabela genérica de `credential`; framework SSI; abstrações de VC
futuras; reativação; expurgo automático do status.

> **Atualizado pelo [ADR-0028](0028-did-e-did-document-do-issuer.md):** DID/DID
> Document do issuer foram implementados em um passo separado. Status/revogação
> não mudou: o valor do status continua fora do documento assinado e o DID
> Document não carrega `credentialStatus`.

## Testes

- `packages/credential/src/schema/status.schema.test.ts` — parsing estrito de
  `credentialStatus` e do documento público.
- `packages/credential/src/service/status.service.test.ts` — determinismo do id,
  opacidade, isolamento entre tenants, independência da chave e formato das
  URLs.
- `packages/credential/src/service/credential.service.test.ts` — `id`/
  `credentialStatus` assinados; adulteração do ponteiro ⇒ `INVALID_SIGNATURE`;
  binding incoerente mesmo reassinado ⇒ `MALFORMED_CREDENTIAL`.
- `packages/credential/src/service/verification.service.test.ts` — `ACTIVE` ⇒
  válido; `REVOKED` ⇒ `STATUS_REVOKED`; sem resolver/erro/valor desconhecido ⇒
  `STATUS_UNAVAILABLE`; resolução só depois da assinatura; resolver HTTP com
  allowlist, HTTPS, path exato, sem redirect e documento estrito.
- `apps/api/src/credential.int.test.ts` — emissão `ACTIVE`; endpoint público sem
  autenticação e sem vazamentos; revogação `REVOKED`; rejeição pelo verificador;
  isolamento entre tenants; idempotência; ausência de reativação; retenção de
  evidência preservando o status; revogações concorrentes.
