# ADR-0029: Revogação e expiração da chave de assinatura

## Status

Aceito (2026-10-19). Dá sequência ao
[ADR-0028](0028-did-e-did-document-do-issuer.md) e fecha a limitação de
revogação de chave que o [ADR-0026](0026-chave-de-assinatura-por-tenant.md) e o
próprio ADR-0028 deixaram explícita.

## Contexto

O `issuer_signing_key` já distingue duas coisas:

- `active = false` — **rotação**: a chave deixa de assinar credenciais novas,
  mas continua publicada em `GET /issuers/:scope` e no DID Document para
  verificar as credenciais antigas;
- `active = true` — a chave selecionada para emitir.

Faltava um **hard stop**: uma chave comprometida continuava autorizada em
`assertionMethod` para sempre. O verificador resolvia a chave pública pelo
issuer e não tinha como saber que ela não deveria mais ser confiável. O objetivo
deste passo é o menor mecanismo que fecha essa lacuna **sem** introduzir um
registry SSI, status list de chaves ou KMS:

```text
chave publicada
   │
   ├── active = false  ──► rotação: não assina novas, ainda verifica antigas
   └── revoked_at      ──► hard stop: deixa de ser confiável (novas E antigas)
```

## Decisão

### 1. Uma coluna, dois casos: `revoked_at timestamptz`

Migration `0033_issuer_signing_key_revocation.sql` adiciona somente
`revoked_at timestamptz` (NULL por padrão):

| valor              | significado                                      |
| ------------------ | ------------------------------------------------ |
| `NULL`             | chave confiável                                  |
| passado / presente | revogada (inclusive expirada)                    |
| futuro             | **expiração agendada**; confiável até o instante |

Não existe uma segunda coluna `expires_at`. Expiração planejada e revogação
manual têm o **mesmo efeito de confiança** — a chave para de ser aceita a partir
de um instante. O verificador não precisa saber a intenção (comprometimento vs.
prazo), só se a chave ainda é confiável em `now()`. Duas colunas sobrepostas
criariam dois caminhos para a mesma decisão e uma pergunta sem resposta
(`revoked_at` futuro + `expires_at` passado). A expiração agendada é,
deliberadamente, uma revogação com data futura.

O relógio de referência é o **PostgreSQL** (`now()`), não o processo Node. A
revogação imediata grava `revoked_at = now()` no próprio `UPDATE`, e a condição
de confiança usa o mesmo `now()`; assim não há janela de skew entre a escrita e
a leitura.

### 2. `active` continua sendo rotação — não revogação

As duas colunas são independentes:

- `active = false` **preserva** a chave nos documentos públicos. Uma credencial
  assinada por ela antes da rotação continua verificável.
- `revoked_at` remove a chave dos documentos públicos a partir do instante
  gravado. Isso vale para credenciais emitidas **antes** da revogação: o
  verificador não encontra mais o método e falha fechado.
- Uma chave pode estar `active = true` e `revoked_at` futuro (expiração
  agendada). Ela ainda assina até o instante; depois, a emissão e a verificação
  passam a falhar.
- Uma chave `active = false` e `revoked_at` futuro continua publicada até o
  instante; depois sai. A rotação não é desfeita.

A invariante "no máximo uma chave ativa por tenant" (índice parcial único
`issuer_signing_key_active_uq`) é preservada. Quando a única chave ativa está
revogada/vencida, o provisionamento desativa essa linha (`active = false`,
liberando o índice) antes de inserir uma nova chave ativa; o `revoked_at` e a
chave pública permanecem intactos no histórico.

### 3. Leitura pública: o documento não publica chave revogada

A mesma condição é usada por todos os leitores:

```sql
revoked_at IS NULL OR revoked_at > now()
```

- `GET /issuers/:scope` e `GET /.well-known/comprova-issuer/:scope`;
- `GET /issuers/:scope/did.json` (`verificationMethod` e `assertionMethod`);
- seleção da chave de emissão (`loadActiveSigningKey`);
- decisão de qual chave nasce ativa no provisionamento.

Se **todas** as chaves de um escopo estiverem revogadas/vencidas, os documentos
públicos respondem `404` — não existe documento válido sem método de
verificação. Um DID Document com `verificationMethod` vazio seria inválido pelo
schema e não é uma alternativa mais segura.

### 4. Emissão: falha fechada

`loadActiveSigningKey` exige `active = true` **e** a condição de confiança. Se
a chave ativa foi revogada/expirou, a emissão falha com
`409 CREDENTIAL_NOT_ISSUABLE` / `SIGNING_KEY_UNAVAILABLE`. Não há fallback para
uma chave inativa, para a chave de outro tenant ou para uma chave global.

### 5. Endpoint autenticado

```text
POST /v1/signing-keys/:keyId/revoke
Authorization: Bearer <api key do tenant>

200 { "key_id": "key-1", "revoked_at": "2026-10-19T12:00:00.000Z" }
404 problem+json (chave inexistente ou de outro tenant)
```

- `effective_at` opcional (query string, ISO-8601 UTC) agenda a expiração. Sem
  ele, a revogação é imediata (`now()` do banco).
- A rota é autenticada e o tenant vem da API key, exatamente como
  `POST /v1/credentials/:credentialId/revoke` (ADR-0027). A consulta é escopada
  por RLS: a chave de outro tenant é indistinguível de uma inexistente.
- A rota exige o escopo **`validate:write`**: revogar é uma operação de
  escrita. Uma API key somente-leitura recebe `403 FORBIDDEN`, sem revelar se o
  `key_id` existe.
- A operação é **idempotente e monotônica no sentido de confiança**: a
  confiança só pode encolher. O `UPDATE` casa `revoked_at IS NULL` **ou**
  `revoked_at` mais tarde que o instante pedido; portanto:
  - um pedido com instante **mais cedo** (ou sem `effective_at`, usando
    `now()`) **antecipa** uma expiração agendada — é o caminho de emergência
    para uma chave comprometida;
  - um pedido com instante **igual ou mais tarde** devolve o instante já
    registrado e não o adia;
  - um `revoked_at` já efetivo nunca é reescrito para depois nem para `NULL`.
    Não há rota de reativação.
- O app recebe apenas `UPDATE (revoked_at)` (grant por coluna). Ele não pode
  reescrever a chave pública, o `key_id`, a identidade da linha nem `active`.
  A provisão/rotação continua sendo operação de admin/owner.

### 6. Banco: RLS, grant por coluna e trigger

- `tenant_isolation` já cobre o `UPDATE`; `public_key_read` continua sendo a
  policy pública de `SELECT`.
- `GRANT UPDATE (revoked_at)` mantém o menor privilégio possível para a
  aplicação.
- O trigger `issuer_signing_key_guard` (BEFORE UPDATE) recusa:
  - alteração de `issuer_signing_key_id`, `tenant_id`, `issuer_scope`,
    `key_id`, `algorithm`, `public_key` ou `created_at`;
  - adiamento de um `revoked_at` que já não é NULL (instante mais tarde) e
    tentativa de "desrevogar" (`NULL`); **antecipar** um instante futuro é
    permitido, porque reduz a confiança.
- `active` continua alterável (rotação); o trigger não o protege porque ele não
  é um eixo de confiança, apenas de seleção de assinatura.

### 7. Verificador independente

Nenhuma mudança no formato da credencial e nenhuma dependência nova no
verificador. A credencial continua apontando
`proof.verificationMethod = <issuer.id>#<keyId>`; o resolver HTTP busca o
documento do issuer e procura o método. Se a chave foi revogada, o método não
está mais no documento e o resultado é:

```text
{ "valid": false, "reason": "VERIFICATION_METHOD_UNRESOLVED" }
```

O mesmo vale para `makeHttpDidResolver`: o DID Document deixa de listar o método.
Não há "modo permissivo" nem cache local que prolongue a confiança.

### 8. Compatibilidade

- **Credenciais existentes** não mudam. Elas continuam verificáveis enquanto a
  chave que as assinou estiver publicada (não revogada). Revogar a chave é uma
  decisão explícita de invalidar esse passado.
- **Credenciais emitidas antes do ADR-0029** não têm campo novo; a mudança é
  toda na resolução da chave.
- **Configuração** (`CREDENTIAL_SIGNING_KEYS`) não muda. A chave privada
  continua fora do banco.
- **`GET /issuers/:scope` e o DID Document** mantêm o mesmo formato; a única
  diferença é a omissão de chaves revogadas/vencidas.
- **Rotação** continua sendo o caminho para trocar a chave sem invalidar o
  passado: publicar um `key_id` novo, ativá-lo e (opcionalmente) desativar o
  antigo. Revogar é para comprometimento ou fim de vida deliberado.

## Itens deliberadamente NÃO implementados

KMS/HSM/secret manager; rotação automática; revogação em massa; status list de
chaves; CRL/OCSP; transparência/log de transparência; revogação de DID; múltiplos
métodos de verificação por tenant além do Ed25519/Multikey; janela de carência
para assinaturas antigas; reativação de chave; notificação a consumidores;
cache de decisão de confiança; mudança do formato da VC.

## Testes

- `apps/api/src/services/signing-key-lifecycle.int.test.ts` — revogação com o
  relógio do banco, idempotência/monotonicidade, antecipação de expiração
  agendada, expiração futura vs. passada, isolamento por RLS, grant por coluna
  e trigger (identidade imutável, revogação só encolhe, `active` ainda
  alterável).
- `apps/api/src/services/provision-signing-keys.int.test.ts` — chave ativa
  revogada/vencida libera o índice para a próxima nascer ativa; expiração futura
  ainda preserva a próxima como inativa.
- `apps/api/src/credential.int.test.ts` — endpoint autenticado, exigência de
  `validate:write` (403 para chave somente-leitura), idempotência, isolamento
  entre tenants, 404 para chave desconhecida/de outro tenant, omissão
  nos documentos `/issuers/:scope` e `/did.json`, falha fechada na verificação
  (`VERIFICATION_METHOD_UNRESOLVED`) e na emissão (`SIGNING_KEY_UNAVAILABLE`),
  expiração agendada, antecipação de emergência e a distinção rotação vs.
  revogação.
- `packages/credential/src/schema/issuer.schema.test.ts` — forma da resposta
  `{ key_id, revoked_at }`.
