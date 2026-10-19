# ADR-0026: Chave de assinatura por tenant (identidade criptográfica do issuer)

## Status

Aceito (2026-10-19). Dá sequência ao
[ADR-0025](0025-emissao-http-e-chave-publica-do-issuer.md), que introduziu a
emissão HTTP, o documento público do issuer e o verificador com resolução de
chave, mas deixou **uma única chave global** assinando todos os issuers.

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
| `active`                | `false` = chave superada (rotação futura)                    |
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

A aplicação só **lê** (`GRANT SELECT`); a provisão é operação de admin/seed,
como a criação de `api_key`.

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
inválida ou chave não-Ed25519 **derrubam a API** (falha fechado). **Não existe
chave global de reserva:** um tenant sem entrada (ou sem chave registrada no
banco) não emite.

`pnpm db:provision-key` publica a chave pública derivada de cada entrada em
`issuer_signing_key` (`onConflictDoUpdate` por `tenant_id`+`key_id`).

### 3. Fronteira: `@comprova/credential` continua pura

O `Signer` segue recebendo **apenas os bytes**. Nada de banco na biblioteca:

```text
apps/api = persistência + configuração + resolução da chave
packages/credential = domínio criptográfico puro
```

Fluxo de emissão (`issueCredential`):

```text
issueCredential(db, tenant, validationId, { issuerOrigin, signingKeys })
  ├─ loadAssertionSource        (RLS; elegibilidade inalterada)
  ├─ loadActiveSigningKey       (RLS; SELECT issuer_signing_key WHERE active)
  ├─ signingKeys(tenant, keyId) (config; privada em memória)   ── null ⇒ SIGNING_KEY_UNAVAILABLE
  ├─ createPublicKey(priv) == public_key publicada             ── ≠   ⇒ SIGNING_KEY_MISMATCH
  └─ buildCredential(issuer = localIssuer(origem, tenant, keyId), Signer)
```

O guard de coerência garante que a credencial **não** saia assinada por uma chave
que o verificador não consegue resolver.

### 4. `key_id`, `verificationMethod` e rotação

O identificador completo continua `issuer.id + "#" + key_id`
(`<origem>/issuers/<escopo>#<keyId>`). O `key_id` é deliberadamente **não** único
globalmente: o namespace é o issuer, então `key-1` pode repetir entre tenants.

O `GET /issuers/:scope` (inalterado no formato) agora lista **todas** as chaves
registradas para aquele `issuer_scope` (não só a ativa), o que permite a
coexistência de rotação: uma credencial antiga aponta `#key-1`, uma nova
`#key-2`, e ambas resolvem no mesmo documento. **Rotação automática não está
implementada** — o processo administrativo é apenas deixado possível (`active`).

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

DID / `did:web` / DID Document; JWKS genérico; rotação automática de chave /
administração de chaves; KMS/HSM/secret manager; criptografia caseira para
segredo; wallet, VP, selective disclosure, SD-JWT, BBS+; TSA/RFC 3161;
revogação/status list; blockchain/Merkle; registry/banco de credenciais; event
sourcing; nova representação paralela da assertion.

## Limitação operacional declarada

Sem KMS/HSM, o material privado vive em configuração/segredo externo
(`CREDENTIAL_SIGNING_KEYS`) e é associado à chave publicada por
(`tenant_id`, `key_id`). Isto é uma **limitação temporária e explícita** deste
passo — não uma arquitetura final. A seleção por tenant/`key_id` já existe, de
modo que a substituição por um secret manager/KMS no futuro não muda o contrato
da aplicação.

## Testes

- `packages/credential/src/resolver.test.ts` — documento do issuer com lista de
  métodos e verificação com resolução (inalterados à parte da assinatura de
  `issuerKeyDocumentOf`).
- `apps/api/src/services/signing-keys.test.ts` — resolução por (tenant,
  `key_id`); lista vazia; JSON inválido, duplicata e chave não-Ed25519 recusados.
- `apps/api/src/credential.int.test.ts` — dois tenants com chaves diferentes
  (mesmo `key_id`) emitem e cada credencial só valida com a sua chave pública;
  o verificador remoto resolve pelo issuer e recusa o `verificationMethod` do
  outro; `GET /issuers/:scope` publica só a chave do issuer pedido (e `404` para
  escopo sem chave); tenant sem chave ⇒ `409` (`SIGNING_KEY_UNAVAILABLE`);
  material privado incoerente com a chave publicada ⇒ `409`
  (`SIGNING_KEY_MISMATCH`).
- `apps/worker/.../deep-enrich.int.test.ts` — emissão direta com a chave do
  tenant continua verificável.
