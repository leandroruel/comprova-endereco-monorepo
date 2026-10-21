# ADR-0026: Chave de assinatura por tenant (identidade criptográfica do issuer)

## Status

Aceito (2026-10-19). Dá sequência ao
[ADR-0025](0025-emissao-http-e-chave-publica-do-issuer.md), que introduziu a
emissão HTTP, o documento público do issuer e o verificador com resolução de
chave, mas deixou **uma única chave global** assinando todos os issuers.

**Atualizado pelo [ADR-0029](0029-revogacao-e-expiracao-de-chave-de-assinatura.md):**
`revoked_at` adiciona o hard stop de revogação/expiração, separado de `active`
(que continua sendo rotação).

## Contexto

Depois do ADR-0025, cada tenant já tem o seu próprio `issuer.id`
(`<origem>/issuers/<escopo>`), mas todos assinavam com a mesma
`CREDENTIAL_SIGNING_PRIVATE_KEY`:

```text
tenant A ─┐
tenant B ─┼──> mesma chave privada
tenant C ─┘
```

Isso significa que o comprometimento de uma chave atinge **todos** os issuers, e
não há como um tenant ter (nem trocar) a própria chave. O objetivo aqui é o passo
mínimo — e reversível — para:

```text
tenant A ──> issuer A ──> key A
tenant B ──> issuer B ──> key B
tenant C ──> issuer C ──> key C
```

## Decisão

### 1. Tabela `issuer_signing_key` (só material público)

Migration `0031_issuer_signing_key.sql`:

| coluna                  | papel                                                        |
| ----------------------- | ------------------------------------------------------------ |
| `issuer_signing_key_id` | PK                                                           |
| `tenant_id`             | FK `tenant` — a chave pertence a exatamente um tenant        |
| `issuer_scope`          | digest do tenant na URL (`issuerScopeOf`), índice de leitura |
| `key_id`                | fragmento do `verificationMethod`                            |
| `algorithm`             | `Ed25519`                                                    |
| `public_key`            | chave pública crua (32 bytes) — **nunca a privada**          |
| `active`                | `false` = chave superada (rotação)                           |
| `revoked_at`            | ADR-0029: hard stop; `NULL` = confiável, futuro = expiração  |
| `created_at`            | —                                                            |

Restrições: `UNIQUE (tenant_id, key_id)` (o `key_id` é único **dentro** do
issuer) e índice parcial único `UNIQUE (tenant_id) WHERE active` (no máximo uma
chave ativa por tenant: a seleção da chave de emissão é determinística).

RLS ligada (`ENABLE`+`FORCE`), com:

- `tenant_isolation` (`FOR ALL`, `USING`/`WITH CHECK tenant_id = app_tenant_id()`);
- `public_key_read` (`FOR SELECT USING (true)`) — a tabela **só** carrega material
  público (chave pública e metadados do método), e o endpoint público
  `GET /issuers/:scope` precisa lê-la **sem** contexto de tenant. Nada
  confidencial é exposto; a chave privada nunca entra aqui.

A aplicação **lê** a chave e pode apenas atualizar `revoked_at` (grant por
coluna; ADR-0029). A provisão é operação de admin/seed, como a criação de
`api_key`.

### 2. Onde vive a chave privada

A privada **nunca** é persistida. Ela vive em configuração/segredo externo e é
associada ao registro público pelo par (`tenant_id`, `key_id`):

```text
CREDENTIAL_SIGNING_KEYS = [
  { "tenant_id": "<uuid>", "key_id": "key-1", "private_key_pem": "<PKCS#8 PEM Ed25519>" },
  ...
]
```

`makeSigningKeyResolver` (`apps/api`) lê esse JSON no boot: JSON inválido, PEM
inválida ou chave não-Ed25519 **derrubam a API** (falha fechado). O `tenant_id`
é normalizado para minúsculas (o escopo é o digest do **texto**, não do `uuid`
canônico do Postgres) e o `key_id` passa pela mesma validação de fragmento de URL
usada por `localIssuer`; configuração inválida não sobe. **Não existe chave
global de reserva:** um tenant sem entrada (ou sem chave registrada no banco) não
emite.

`pnpm db:provision-key` publica a chave pública derivada de cada entrada em
`issuer_signing_key`, com duas invariantes:

- **Nunca sobrescreve uma chave publicada.** Se o par (`tenant_id`, `key_id`) já
  existe com a mesma chave pública, é idempotente; se a chave pública mudou, o
  comando **falha** e exige um `key_id` novo — sobrescrever invalidaria as
  credenciais antigas, que resolvem a pública por esse par.
- **Preserva a chave ativa.** A primeira chave de um tenant só é ativada se ele
  ainda não tiver nenhuma ativa (incluindo as inseridas na mesma execução);
  chaves adicionais entram inativas — assim o índice parcial único não colide e
  quem assina não muda sem um passo administrativo explícito.

### 3. Fronteira: `@comprova/credential` continua pura

O `Signer` segue recebendo **apenas os bytes**. Nada de banco na biblioteca:

```text
apps/api = persistência + seleção de lifecycle + provider de assinatura
packages/credential = domínio criptográfico puro
```

A resolução do material privado fica atrás de `SigningKeyProvider`
(`apps/api/src/services/signing-key-provider.ts`), cuja implementação **atual** é
a de configuração local (`CREDENTIAL_SIGNING_KEYS`). O domínio de emissão só diz
"assine com esta chave":

```text
issueCredential(db, tenant, validationId, { issuerOrigin, signingKeyProvider })
  ├─ loadAssertionSource       (RLS; elegibilidade inalterada)
  ├─ loadActiveSigningKey      (RLS; lifecycle: active + revoked_at)
  ├─ signingKeyProvider.signerFor({ tenantId, keyId, publicKey })
  │      └─ resolve o material e confere a pública publicada
  │         (ausente ⇒ SIGNING_KEY_UNAVAILABLE; incoerente ⇒ SIGNING_KEY_MISMATCH)
  └─ buildCredential(issuer = localIssuer(origem, tenant, keyId), Signer)
```

Quatro responsabilidades separadas — nenhuma delas mistura as outras:

```text
Key lifecycle / selection   (loadActiveSigningKey: active + revoked_at, RLS)
Private-key storage         (provider; hoje CREDENTIAL_SIGNING_KEYS)
Cryptographic signing       (Signer sobre Ed25519)
Public-key publication      (GET /issuers/:scope, DID Document; só pública)
```

O guard de coerência garante que a credencial **não** saia assinada por uma chave
que o verificador não consegue resolver. KMS/HSM serão implementações **futuras**
de `SigningKeyProvider`, sem tocar o domínio de emissão; a implementação atual
continua sendo a de configuração local (ver "Limitação operacional declarada").

### 4. `key_id`, `verificationMethod` e rotação

O identificador completo continua `issuer.id + "#" + key_id`
(`<origem>/issuers/<escopo>#<keyId>`). O `key_id` é deliberadamente **não** único
globalmente: o namespace é o issuer, então `key-1` pode repetir entre tenants.

O `GET /issuers/:scope` (inalterado no formato) agora lista **todas** as chaves
registradas e **não revogadas/vencidas** para aquele `issuer_scope` (não só a
ativa), o que permite a coexistência de rotação: uma credencial antiga aponta
`#key-1`, uma nova `#key-2`, e ambas resolvem no mesmo documento. **Rotação
automática não está implementada** — o processo administrativo é apenas deixado
possível (`active`). Revogar/expirar é um eixo separado (`revoked_at`), definido
no ADR-0029.

## Compatibilidade e impacto

- **Configuração substituída:** `CREDENTIAL_SIGNING_KEY_ID` +
  `CREDENTIAL_SIGNING_PRIVATE_KEY` (globais) → `CREDENTIAL_SIGNING_KEYS`
  (por tenant). Sem entradas, a API sobe, mas nenhum tenant emite.
- **Nova migração** (`0031`) e tabela `issuer_signing_key`; novo script
  `pnpm db:provision-key`.
- **`GET /issuers/:scope`** passa a ler o banco e pode responder `404` para
  escopo sem chave (antes sempre respondia `200`).
- **`packages/credential` inalterado na fronteira** (só um ajuste de assinatura
  interna de `issuerKeyDocumentOf`, que agora aceita uma lista de métodos
  públicos; o formato JSON da resposta é o mesmo).
- **Nenhuma mudança** em `validation`/`claim`/`claim_evidence`/`signal`/`evidence`,
  scoring, checkers, policy, `building_key`/`unit_key`, retenção ou no formato da
  VC além do estritamente necessário.

## Itens deliberadamente NÃO implementados

DID / `did:web` / DID Document (feito no ADR-0028); JWKS genérico; rotação
automática de chave / administração de chaves; KMS/HSM/secret manager;
criptografia caseira para segredo; wallet, VP, selective disclosure, SD-JWT,
BBS+; TSA/RFC 3161; revogação/status list de credenciais em massa;
blockchain/Merkle; registry/banco de credenciais; event sourcing; nova
representação paralela da assertion. Revogação/expiração de **chave** foi feita
no ADR-0029.

## Limitação operacional declarada

Sem KMS/HSM, o material privado vive em configuração/segredo externo
(`CREDENTIAL_SIGNING_KEYS`) e é associado à chave publicada por
(`tenant_id`, `key_id`) — atrás de `SigningKeyProvider`
(`makeConfiguredSigningKeyProvider`). Isto é uma **limitação temporária e
explícita** deste passo — não uma arquitetura final. A seleção por
tenant/`key_id` e a fronteira de assinatura já existem, de modo que a
substituição por um secret manager/KMS no futuro é outra implementação do
provider (`class KmsSigningKeyProvider implements SigningKeyProvider`), sem
mudar o domínio de emissão, o formato da VC, o `proof`, o DID, o verificador nem
o `credentialStatus`.

## Testes

- `packages/credential/src/resolver.test.ts` — documento do issuer com lista de
  métodos e verificação com resolução (inalterados à parte da assinatura de
  `issuerKeyDocumentOf`).
- `apps/api/src/services/signing-keys.test.ts` — resolução por (tenant,
  `key_id`); lista vazia; JSON inválido, duplicata e chave não-Ed25519 recusados.
- `apps/api/src/services/signing-key-provider.test.ts` — provider de assinatura
  local: assina e a assinatura verifica com a pública publicada; material
  ausente ⇒ `SIGNING_KEY_UNAVAILABLE` e material incoerente ⇒
  `SIGNING_KEY_MISMATCH`; isolamento por (`tenant_id`, `key_id`); determinismo
  (mesmos bytes/chave ⇒ mesma assinatura); configuração inválida falha no boot.
- `apps/api/src/credential.int.test.ts` — dois tenants com chaves diferentes
  (mesmo `key_id`) emitem e cada credencial só valida com a sua chave pública;
  o verificador remoto resolve pelo issuer e recusa o `verificationMethod` do
  outro; `GET /issuers/:scope` publica só a chave do issuer pedido (e `404` para
  escopo sem chave); tenant sem chave ⇒ `409` (`SIGNING_KEY_UNAVAILABLE`);
  material privado incoerente com a chave publicada ⇒ `409`
  (`SIGNING_KEY_MISMATCH`).
- `apps/worker/.../deep-enrich.int.test.ts` — emissão direta com a chave do
  tenant continua verificável.
- `apps/api/src/services/provision-signing-keys.int.test.ts` — provisionamento
  repetível: primeira chave ativa, repetição idempotente, recusa de sobrescrita
  (mesmo `key_id`, material novo) e chave adicional entrando inativa sem
  colidir no índice parcial único nem trocar quem assina.
- `apps/api/src/services/signing-key-lifecycle.int.test.ts` — ADR-0029:
  revogação/expiração, idempotência, RLS, grant por coluna e trigger.
- `apps/api/src/credential.int.test.ts` — ADR-0029: chave revogada/vencida
  ausente dos documentos públicos e falha fechada na verificação e na emissão;
  rotação (`active = false`) continua publicada.
