# ADR-0025: Porta HTTP de emissão e publicação da chave pública do issuer (verificação com resolução)

## Status

Aceito (2026-10-19). Dá sequência ao
[ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md) e ao
[ADR-0020](0020-verifiable-credential-data-model-2.md), que deixaram
explicitamente fora de escopo o "endpoint HTTP de emissão" e a
"publicação/resolução de chave". Nada do documento W3C, do domínio, do schema
ou da assinatura é alterado aqui.

## Contexto

A camada `@comprova/credential` já produz uma VC 2.0 assinada
(`eddsa-jcs-2022`) a partir de uma `validation` concluída, e `verifyCredential`
verifica a credencial sem banco. Faltava o mínimo para um terceiro usar isso:

1. uma porta HTTP que devolva a credencial de uma `validation`;
2. a publicação do material **público** do issuer;
3. um verificador que **resolva** a chave a partir do
   `proof.verificationMethod` — hoje a chave é injetada pelo consumidor.

A chave de assinatura também não tinha origem na aplicação: só os testes
construíam o `Signer` diretamente.

Restrições mantidas: nenhuma tabela/migração; `packages/credential` puro
(sem banco/Redis/Temporal/S3/Fastify); sem DID/DID Document; sem JWKS genérico;
sem rotação; sem KMS/HSM; sem tocar em `building_key`/`unit_key`/`doc_hmac`/
scoring/checkers/policy/T0-T2/retenção.

## Decisão

### 1. `POST /v1/validations/:id/credential`

- Rota autenticada pelo mecanismo existente (o `preHandler` de auth/rate-limit
  do bloco `/v1`), escopada pelo tenant da requisição.
- O controller **não** reimplementa regra de negócio: chama `issueCredential`
  (a fronteira de leitura + elegibilidade) e devolve o JSON da credencial.
  Carregamento da validation, verificação de bindings, subject, evidence set,
  policy hash e assinatura continuam em
  `apps/api/src/services/credential-issuer.ts` / `@comprova/credential`.
- A elegibilidade é exatamente a existente: só `status = completed`, resultado
  completo, `completed_at` presente, janela `completed_at < expires_at`,
  `evidence_set_hash` consistente, claim/subject/evidências presentes. Não há
  regra nova.
- **Falha de emissão → `problem+json` estável.** `VALIDATION_NOT_FOUND` →
  `404 NOT_FOUND`; as demais falhas de elegibilidade → `409 CREDENTIAL_NOT_ISSUABLE`
  (novo código em `@comprova/contracts`), com a razão interna
  (`VALIDATION_NOT_FINAL`, `COMPLETION_TIME_MISSING`, `VALIDITY_WINDOW_INVALID`,
  `CLAIM_MISSING`, `SUBJECT_MISSING`, `EVIDENCE_MISSING`) em `detail`.
- **Tenant isolation:** `issueCredential` lê sob RLS e deriva o issuer do MESMO
  tenant escopado; a validation de outro tenant nem é encontrada
  (`VALIDATION_NOT_FOUND`). Não existe caminho para emitir credencial de outro
  tenant.

### 2. Chave de assinatura: configuração explícita, falha no boot

> **Superado pelo [ADR-0026](0026-chave-de-assinatura-por-tenant.md).** Esta
> chave era **global** (uma só para todos os issuers). O ADR-0026 a substitui por
> chave **por tenant** (`CREDENTIAL_SIGNING_KEYS`) e por um registro público em
> `issuer_signing_key`; o princípio de "configuração explícita, falha no boot"
> continua. O histórico abaixo fica como registro.

```
CREDENTIAL_ISSUER_ORIGIN     = <origem HTTPS>      (já existia, ADR-0024)
CREDENTIAL_SIGNING_KEY_ID    = <fragmento>          (novo)
CREDENTIAL_SIGNING_PRIVATE_KEY = <PKCS#8 PEM Ed25519> (novo)
```

- A privada é PKCS#8 PEM (o que `openssl genpkey -algorithm ED25519` produz;
  nada proprietário), lida por `ed25519PrivateKeyFromPkcs8Pem` — que também
  aceita `\n` escapado, para arquivos de ambiente de linha única.
- `buildApp` resolve a chave e monta o `Signer` **antes** de registrar rotas:
  ausente/inválida/não-Ed25519, a API **não sobe** (falha fechado).
- A privada nunca é logada, devolvida nem incluída em resposta pública.
- **Sem rotação.** Trocar a chave é trocar a configuração; o `keyId` vive no
  fragmento (`<issuer.id>#<keyId>`), então a identidade do issuer não muda.

### 3. Documento público do issuer: `GET /issuers/:scope`

- Rota **pública** (fora do `/v1`), derivada do `issuer.id` existente:
  `issuer.id = <origem>/issuers/<escopo>` ⇒ recurso em `GET /issuers/<escopo>`.
- `scope` é validado como o digest de 43 chars base64url (`issuerScopeOf`);
  o documento reconstrói `id = <origem>/issuers/<scope>`.
- Resposta (só material público), com o método em `publicKeyMultibase`
  (multicodec `ed25519-pub` + base58btc Multibase, formato Multikey da W3C):

```json
{
  "id": "<issuer.id>",
  "verificationMethod": [
    {
      "id": "<issuer.id>#<keyId>",
      "type": "Multikey",
      "controller": "<issuer.id>",
      "publicKeyMultibase": "z<base58btc>"
    }
  ]
}
```

- **Não é um DID Document:** sem `@context` de DID, sem `did:`, sem `did.json`,
  sem `assertionMethod`. É o "documento do issuer" que o ADR-0024 §2 já
  antecipava em `GET <issuer.id>`, com o `publicKeyMultibase` que ele nomeia.
- Não retorna `tenant_id`/`api_key_id`/`user_id`/`doc_hmac`, dados da validation
  nem do subject.
- **Nenhuma tabela `issuer`/`verification_method`:** o documento é derivado da
  configuração (chave + origem). O escopo é um digest unidirecional do tenant;
  não há como (nem necessidade de) reverter escopo → tenant.
- **Atualizado pelo [ADR-0026](0026-chave-de-assinatura-por-tenant.md):** o
  documento passa a ser lido de `issuer_signing_key` por `issuer_scope`, lista
  **todas** as chaves daquele issuer (coexistência de rotação) e responde **404**
  quando não há chave registrada para o escopo. O formato JSON não muda.

### 4. Resolver: dependência explícita com allowlist

```ts
type VerificationMethodResolver = (vm: string) => Promise<{ id: string; publicKey: KeyObject }>
```

- `makeHttpIssuerResolver({ trustedIssuerOrigins, fetch? })` busca
  `GET <issuer.id>` e devolve a chave do método pedido. Ele:
  - exige HTTPS e só busca **origens na allowlist** (`trustedIssuerOrigins`);
  - recusa documento cujo `id` não é o issuer pedido, que não lista o método,
    ou cujo `controller` não é o issuer;
  - falha como `VerificationMethodResolutionError` quando não resolve.
- A allowlist é o que impede a credencial de apontar para uma chave arbitrária
  controlada por um atacante (o clássico "resolver qualquer URL"). O resolver é
  injetado, então o consumidor decide em quem confia; a biblioteca não lê
  ambiente.

### 5. Verificador com resolução: `verifyCredentialFromIssuer`

```ts
await verifyCredentialFromIssuer(credential, resolver, { expectedIssuerId? })
```

Ordem: forma mínima → **`verificationMethod` pertence ao `issuer` declarado**
(`<issuer>#<fragmento>`) → `expectedIssuerId` (se informado) → resolve → exige
`resolved.id === verificationMethod` → delega a `verifyCredential` com o método
confiável resolvido. Falhas = as de `verifyCredential` mais
`VERIFICATION_METHOD_UNRESOLVED`.

- O vínculo estrutural é checado **antes** de resolver: a credencial não escolhe
  de quem buscar a chave.
- `verifyCredential` continua puro e inalterado; a rede fica só no resolver
  injetado. O pacote segue utilizável fora da API.

## Compatibilidade e impacto

- **Novas dependências de configuração obrigatórias** na API:
  `CREDENTIAL_SIGNING_KEY_ID`/`CREDENTIAL_SIGNING_PRIVATE_KEY`. Sem elas
  (ou com chave inválida), a API não sobe.
- **Novo código de problema** `CREDENTIAL_NOT_ISSUABLE` (409) em
  `@comprova/contracts`; nenhuma rota existente muda de contrato.
- **Novas exportações** em `@comprova/credential`:
  `issuerKeyDocumentOf`/`IssuerKeyDocumentSchema`, `encode/decodeEd25519PublicKeyMultibase`,
  `ed25519PrivateKeyFromPkcs8Pem`, `makeHttpIssuerResolver`,
  `verifyCredentialFromIssuer`.
- **Nenhuma migração, schema, worker, pipeline, scoring, checker, policy,
  `building_key`/`unit_key` ou retenção alterados.** Nenhuma credencial é
  persistida.

## Itens deliberadamente NÃO implementados

DID / `did:web` / DID Document; JWKS genérico; rotação de chave / key registry;
KMS/HSM/secret manager; wallet, VP, selective disclosure, SD-JWT, BBS+;
TSA/RFC 3161; revogação/status list; blockchain/Merkle; registry/banco de
credenciais; event sourcing. Nenhuma tabela nova.

## Testes

- `packages/credential/src/resolver.test.ts`: round-trip de
  `publicKeyMultibase`; documento do issuer; `verifyCredentialFromIssuer` válido;
  adulteração da carga → `INVALID_SIGNATURE`; chave errada →
  `INVALID_SIGNATURE`; método inexistente → `VERIFICATION_METHOD_UNRESOLVED`;
  `verificationMethod` incompatível com o issuer rejeitado **antes** de chamar o
  resolver; malformada; issuer esperado divergente; e o resolver HTTP
  (allowlist, HTTPS, `id` divergente, HTTP não-ok, documento malformado).
- `apps/api/src/credential.int.test.ts`: `POST /v1/validations/:id/credential`
  devolve a VC e `verifyCredentialFromIssuer` valida via resolver HTTP apoiado no
  roteador do Fastify; `GET /issuers/:scope` publica só a chave pública
  (a `publicKeyMultibase` reconstrói o `KeyObject` do par); sem chave privada nem
  identificadores internos; 401 sem auth; tenant isolation (404); não-final e
  janela inválida (409, `CREDENTIAL_NOT_ISSUABLE`, `expires_at` intacto); o JSON
  transportado é autocontido.
