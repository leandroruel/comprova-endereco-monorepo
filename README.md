# comprova-endereco

Address Intelligence API: valida o endereço de um CNPJ/CPF cruzando múltiplos sinais (Receita Federal, CNEFE/IBGE, CEP, co-tenância, geocoding, fachada) e devolve um veredito explicável com score de confiança e trilha de auditoria.

## Quickstart

Requer Node `>=22.12` e pnpm 12 (`corepack enable`, ou `npm i -g pnpm@12`): o
`packageManager` do repo pina `pnpm@12.14.0` e versões anteriores não conseguem
provisioná-lo. O pnpm 12 traz de padrão uma quarentena de 24h para versões
recém-publicadas (`minimumReleaseAge`) — um `pnpm install` que falhe com
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` está recusando uma release nova, não
quebrado.

```bash
cp .env.example .env   # defaults do docker-compose; ajuste os segredos
pnpm install
pnpm db:migrate
pnpm db:seed           # imprime a API key do tenant de dev
# cole a chave em VITE_API_KEY no .env
pnpm dev
```

| Serviço                         | Porta            |
| ------------------------------- | ---------------- |
| Dashboard (React + Better Auth) | 5173             |
| API (Fastify)                   | 3000             |
| Postgres 16 + PostGIS           | 5432             |
| Redis/Valkey                    | 6379             |
| Temporal                        | 7233 / 8233 (UI) |
| Object storage (S3-compatible)  | 9000             |

## Ambiente

Tudo vem do `.env` na raiz — `.env.example` documenta as variáveis e o
`.gitignore` protege o arquivo. Dois pontos que costumam pegar:

- **`VITE_API_KEY`** é a chave que o dashboard manda no `Authorization: Bearer`.
  O `envDir` do Vite aponta para a raiz, então é o mesmo arquivo que os scripts
  do backend leem (`tsx --env-file=.env`); só o que começa com `VITE_` chega ao
  browser. Sem a chave a API responde 401 e o dashboard loga o motivo no
  console. Uma chave nova sai de `pnpm db:seed` (tenant de dev) ou de
  `pnpm --filter @comprova/ingestor start -- load-tenant` (tenant de carga).
- **`API_KEY_PEPPER`** é o segredo do HMAC das chaves (a linha guarda só o
  HMAC, nunca a chave). Trocar o pepper **invalida todas as chaves emitidas** —
  o `pnpm db:seed` só cria outra se o tenant de dev não tiver nenhuma ativa.
  Para revogar uma chave, `UPDATE api_key SET revoked_at = now() WHERE ...`; a
  API confere a revogação no banco, mas guarda o resultado por 60s em memória
  (cache por prefixo), então o 401 pode demorar até um minuto.
- **`CREDENTIAL_ISSUER_ORIGIN`** é a origem HTTPS **controlada pelo projeto**
  que serve de base para o `issuer` e para o `credentialSubject.id` das
  credenciais verificáveis (ADR-0024). Não há default e a biblioteca não
  conhece domínio nenhum: o valor é validado no boot (HTTPS, sem
  path/query/fragmento) e, enquanto não houver um domínio de produção
  confirmado, use uma origem reservada (`https://issuer.test`). O `tenant_id`
  interno **não** aparece na URL — o path do issuer leva um digest do tenant. A
  validação da origem é **fail-safe**: só é relaxada com `NODE_ENV=development`
  ou `NODE_ENV=test`; com `NODE_ENV` ausente, `prod`, `staging` ou `production`
  o boot recusa TLDs reservados (`.test`, `.example`, `.invalid`, `.localhost`,
  `.local`), `localhost` e IP literal. Como o `issuer.id` (e o `credential_id`)
  derivam da origem, **trocar `CREDENTIAL_ISSUER_ORIGIN` impede reemitir
  validations já emitidas** — a API responde `409 CREDENTIAL_NOT_ISSUABLE` com
  detalhe `ISSUANCE_IDENTITY_CONFLICT`; a origem definitiva deve ser escolhida
  antes de emitir em produção.
- **`CREDENTIAL_SIGNING_KEYS`** assina a credencial **por tenant** (ADR-0026).
  É um JSON — lista de `{"tenant_id", "key_id", "private_key_pem"}` — lido no
  boot: JSON inválido, PEM inválida ou chave não-Ed25519 **derrubam a API**
  (falha fechado). Cada tenant assina com a sua própria chave; um tenant sem
  entrada na configuração (ou sem chave registrada em `issuer_signing_key`)
  **não** emite (`409 CREDENTIAL_NOT_ISSUABLE`, detalhe
  `SIGNING_KEY_UNAVAILABLE`) — não existe chave global de reserva. O `key_id` é
  o fragmento publicado em `proof.verificationMethod` (`<issuer.id>#<keyId>`) e
  pode se repetir entre tenants (o namespace é o issuer). Só o material
  **público** sai da API (`GET /issuers/:scope` e a porta de descoberta
  `GET /.well-known/comprova-issuer/:scope`, em `publicKeyMultibase`); a
  privada nunca é persistida, logada nem devolvida. A chave pública publicada
  tem de **corresponder** ao material configurado, senão a emissão falha com
  `SIGNING_KEY_MISMATCH`. (Limitação operacional deste passo: sem KMS/HSM, o
  material privado vive em configuração/segredo externo.) Uma chave com
  `revoked_at` (ADR-0029) sai dos documentos públicos e deixa de ser aceita; o
  `active = false` continua sendo apenas rotação.
- **Validade da credencial** (ADR-0024, revisão pós-PR #5): `validFrom` é o
  `completed_at` real e `validUntil` é
  `min(completed_at + policy.credential_ttl_seconds, observed_at + ttl_seconds)`.
  `credential_ttl_seconds` é opcional na policy (default **30 dias**) e não
  altera policies já publicadas; o TTL de cada evidência limita a credencial. A
  janela vazia/invertida falha com `VALIDITY_WINDOW_INVALID`. `expires_at`
  continua sendo o horizonte de **retenção**, não o `validUntil`.
- **Reemissão determinística** (ADR-0024, B2): a primeira emissão por validation
  é registrada em `credential_issuance` (`issued_at` + `credential_id` público,
  sem o documento assinado). Reemitir reassina com `proof.created = issued_at` e
  devolve bytes idênticos enquanto issuer/chave/policy não mudarem; o status
  `ACTIVE`/`REVOKED` continua em uma única linha e não é reativado.
- **Credenciais superadas** (ADR-0024, C1): quando o deep path muda veredito,
  evidências, policy ou scorer, ou regride a validation concluída para
  `partial`, a credencial já emitida é revogada como `superseded` na mesma
  transação. Replay idêntico não revoga, inclusive sob uma policy nova (a
  comparação usa a última policy avaliada, não o binding imutável da assertion);
  a coluna de motivo não é pública.
- **Verificação** (ADR-0024, A2): `verifyCredentialIntegrity` (antigo
  `verifyCredential`) devolve `checked` com integridade, tempo e status. Aceita
  `now` e usa `[validFrom, validUntil)`; sem `now`, declara que o tempo não foi
  checado. Revogação **não** é consultada aqui — use o `statusResolver`.
- **Status/revogação** (ADR-0027): a credencial carrega `id` e
  `credentialStatus.id` assinados, mas o valor (`ACTIVE`/`REVOKED`) fica em uma
  linha por `credential_id` (tabela `credential_status`, isolada por RLS). O
  `POST /v1/credentials/:credentialId/revoke` é autenticado e monotônico; o
  `GET /issuers/:scope/credentials/:credentialId/status` é público e devolve só
  `{ "status": "ACTIVE" | "REVOKED" }`. O verificador independente precisa de um
  `statusResolver`; sem status resolvido ele falha fechado
  (`STATUS_UNAVAILABLE`), e `REVOKED` resulta em `STATUS_REVOKED`.
- **DID/DID Document** (ADR-0028): o issuer tem um DID determinístico
  `did:web:<host>:issuers:<escopo>`, derivado do `issuer.id` (sem `tenant_id`,
  subject, documento ou `validation_id`). O DID Document é público em
  `GET /issuers/:scope/did.json` e publica a mesma chave do issuer em
  `verificationMethod`/`assertionMethod` (`Multikey`/`publicKeyMultibase`), com
  `alsoKnownAs` ligando o DID à URL HTTPS que a credencial já carrega em
  `issuer`. O verificador resolve essa chave por `makeHttpDidResolver`, sem
  banco, chave privada nem API interna. O `issuer` e o
  `proof.verificationMethod` da credencial **não mudaram**.
- **Revogação/expiração de chave** (ADR-0029): `issuer_signing_key.revoked_at`
  é o hard stop, separado de `active`. Um instante passado revoga (inclusive
  credenciais já emitidas); um instante futuro agenda a expiração. A chave
  revogada/vencida não aparece em `GET /issuers/:scope` nem no DID Document, e
  o verificador falha fechado (`VERIFICATION_METHOD_UNRESOLVED`). O
  `POST /v1/signing-keys/:keyId/revoke` é autenticado, escopado por tenant,
  exige `keys:write`, é idempotente e só permite encolher a confiança;
  `?effective_at=<ISO-8601>` agenda a expiração, e uma chamada sem o parâmetro
  antecipa a revogação (nunca a adia). Não há reativação: uma chave apenas
  rotacionada (`active = false`) continua publicada.

## Dashboard

Abre `http://localhost:5173`:

1. Cria conta (email/senha)
2. Valida CNPJ individual ou cria lote (CSV drag & drop / textarea)
3. Vê stats por usuário, vereditos com sinais, export CSV/JSON

## Endpoints da API

| Método          | Path                                      | Descrição                                         |
| --------------- | ----------------------------------------- | ------------------------------------------------- |
| POST            | `/v1/validations`                         | Valida um CNPJ/CPF (fast/auto/deep)               |
| GET             | `/v1/validations/:id`                     | Consulta resultado com ETag                       |
| POST            | `/v1/validations/:id/credential`          | Emite a credencial verificável (JSON)             |
| POST            | `/v1/credentials/:credentialId/revoke`    | Revoga a credencial (idempotente, monotônico)     |
| POST            | `/v1/signing-keys/:keyId/revoke`          | Revoga/agenda a expiração da chave do tenant      |
| POST            | `/v1/validations/:id/contest`             | Contestação (art. 20 LGPD)                        |
| GET             | `/v1/stats`                               | Stats por usuário (total, únicos, por veredito)   |
| POST            | `/v1/batches`                             | Cria lote (background)                            |
| GET             | `/v1/batches`                             | Lista lotes do usuário                            |
| GET             | `/v1/batches/:id`                         | Detalhes do lote                                  |
| GET             | `/v1/batches/:id/export?format=csv\|json` | Download                                          |
| POST/GET/DELETE | `/v1/webhooks`                            | Gestão de webhooks (HMAC)                         |
| GET             | `/v1/subjects/:id/validations`            | Relatório de acesso LGPD                          |
| DELETE          | `/v1/subjects/:id`                        | Eliminação LGPD                                   |
| GET             | `/issuers/:scope`                         | Documento público de chave do issuer (Multikey)   |
| GET             | `/issuers/:scope/did.json`                | DID Document público do issuer (`did:web`)        |
| GET             | `/issuers/:scope/credentials/:id/status`  | Status público da credencial (`ACTIVE`/`REVOKED`) |
| GET             | `/.well-known/comprova-issuer/:scope`     | Descoberta do documento público do issuer         |
| GET             | `/healthz` / `/readyz` / `/metrics`       | Ops                                               |
| GET             | `/openapi.json`                           | OpenAPI 3.1                                       |

### Scopes das API keys

Toda rota `/v1` autentica por API key e exige o scope da operação **antes do
handler** (`preHandler: requireReadScope`, `requireWriteScope` ou
`requireKeysWriteScope`). O contrato define três scopes; o default de
`api_key.scopes` continua com dois, e `keys:write` é opt-in:

| Scope            | Operações                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate:read`  | `GET /v1/validations/:id`, `GET /v1/batches`, `GET /v1/batches/:id`, `GET /v1/batches/:id/export`, `GET /v1/stats`, `GET /v1/meta`, `GET /v1/webhooks`, `GET /v1/subjects/:id/validations`                                                    |
| `validate:write` | `POST /v1/validations`, `POST /v1/validations/:id/contest`, `POST /v1/validations/:id/credential`, `POST /v1/credentials/:credentialId/revoke`, `POST /v1/batches`, `POST /v1/webhooks`, `DELETE /v1/webhooks/:id`, `DELETE /v1/subjects/:id` |
| `keys:write`     | `POST /v1/signing-keys/:keyId/revoke`                                                                                                                                                                                                         |

- **401 `UNAUTHORIZED`** — API key ausente, inválida ou revogada.
- **403 `FORBIDDEN`** — API key válida, mas sem o scope exigido. A resposta é
  genérica e não consulta o recurso; um id de outro tenant não vira oráculo de
  existência.
- **Isolamento por tenant continua no banco** — o scope autoriza a operação,
  não o recurso. RLS/`withTenant` limita toda leitura e mutação ao tenant da
  chave; uma key com `keys:write` do tenant A recebe 404 ao tentar revogar
  signing key do tenant B.
- Emissão e revogação de credencial continuam usando `validate:write`. A
  revogação de signing key usa `keys:write`, separada da key usada para emitir
  credenciais.
- **`keys:write` não é concedido automaticamente** — nem por autenticação, nem
  por `db:seed`/`bootstrap`, nem por `load-tenant`, nem por migration. Keys
  antigas e novas nascem com o default de dois scopes. Como não há endpoint de
  administração de API keys, o grant é operacional, com a credencial de
  administração do banco:

  ```sql
  UPDATE api_key
  SET scopes = array_append(scopes, 'keys:write')
  WHERE api_key_id = '<uuid-da-key>'
    AND NOT ('keys:write' = ANY (scopes));
  ```

  O `UPDATE` é explícito por `api_key_id`, idempotente e deve ser auditado.
  Sem o grant, a revogação de signing key retorna 403.

- O snapshot `validation.issuer_scopes` continua registrando todos os scopes da
  key associado à validation (gravado na criação e imutável). A credencial
  publica em `assertionAuthority.scopes` apenas `validate:read`/`validate:write`;
  `keys:write` não aparece no documento e não é uma permissão do titular.
  Credenciais antigas com `comprova:authorization` continuam verificáveis
  (compatibilidade de leitura).
- As rotas públicas de issuer (`/issuers/:scope`, `did.json`, status e
  `.well-known/comprova-issuer/:scope`) continuam sem API key e sem scope.

A decisão completa está no
[ADR-0030](docs/adr/0030-enforcement-de-scopes-das-api-keys.md).

## Comandos

```bash
pnpm dev          # tudo (API, dashboard, worker, ingestor)
pnpm test         # suíte completa (projetos `node` e `dashboard`)
pnpm test:browser # só os testes de componente, no Chromium real
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm format       # prettier
pnpm db:migrate   # aplica migrações SQL
pnpm db:seed      # tenant dev + imprime a API key
pnpm db:provision-key # publica as chaves de `CREDENTIAL_SIGNING_KEYS` (idempotente; nunca sobrescreve)
pnpm db:fence     # pgfence: gate de segurança de migrações
pnpm seed:golden  # dataset dourado (8 classes de veredito)

# Ingestores
pnpm --filter @comprova/ingestor start -- receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N]
pnpm --filter @comprova/ingestor start -- receita:municipios <csv>
pnpm --filter @comprova/ingestor start -- cnefe:uf <csv>
pnpm --filter @comprova/ingestor start -- ceps:backfill --limit N
pnpm --filter @comprova/ingestor start -- profiles:recompute
pnpm --filter @comprova/ingestor start -- load-tenant
pnpm --filter @comprova/ingestor start -- policy:simulate <versao> [--report]
```

## Testes

A suíte roda em dois projetos do Vitest, escolhidos pela extensão do arquivo:

| Projeto     | Ambiente                   | Alcança                                          |
| ----------- | -------------------------- | ------------------------------------------------ |
| `node`      | Node, `pool: forks`        | `*.test.ts(x)` de API, worker, ingestor, pacotes |
| `dashboard` | Chromium real (Playwright) | `apps/dashboard/src/**/*.test.tsx`               |

Testes de componente (`*.test.tsx`) rodam no browser de verdade: eventos de
ponteiro/teclado, foco e árvore de acessibilidade são os do Chromium, sem jsdom
nem polyfills. O resto continua no Node, que é mais rápido e tem os containers
do Testcontainers.

Pré-requisito para o projeto `dashboard` (o download do Chromium não roda no
`pnpm install`: é um download, não um build script aprovado em `allowBuilds`):

```bash
npx playwright install chromium              # macOS/Windows
npx playwright install --with-deps chromium  # Linux: traz também as libs do sistema (pede sudo)
```

É uma vez por máquina; no CI é um passo do workflow, com o mesmo `--with-deps`.

Os testes de componente não carregam a folha de estilo (Tailwind), então
asserções de visibilidade valem para elementos com caixa própria — cor e
espaçamento não são testados.

Quando um teste de browser falha, o Vitest grava um screenshot em
`.vitest/attachments/failure-screenshots/` (gitignored).

## Modos de validação

| Modo   | Descrição                                                    | Requer           |
| ------ | ------------------------------------------------------------ | ---------------- |
| `fast` | T0 checkers locais (Receita, CEP, CNEFE, co-tenancy) — ~15ms | nada             |
| `auto` | Fast + dispara deep se ambíguo                               | VLM_ENABLED=true |
| `deep` | T0 + T1 (geocoding, POIs) + T2 (VLM) — assíncrono            | VLM_ENABLED=true |

Com `VLM_ENABLED=false` (default), apenas `fast` está disponível — deep/auto retornam `422`.

## Arquitetura

```
Dashboard (React+Vite:5173) ─► API (Fastify:3000)
                                   │ fast path: Postgres + Redis
                                   │ deep path: Temporal → Worker → Providers (OSM, VLM)
                                   │ batch: batch processor em background
                                   └► Postgres 16+PostGIS (particionado, RLS multi-tenant)
```

## Estrutura

```
apps/api            Fastify: auth, rate limit, rotas /v1, stats, batch, export
apps/dashboard      React+Vite: Better Auth, TanStack Query, bulk search, stats
apps/worker         Temporal workers (deep path T1/T2)
apps/ingestor       CLI: Receita, CNEFE, CEP, profiles, policy:simulate
packages/core       Domínio puro (FP): Signal, Checker, scoring, policy, address keys
packages/contracts   Zod schemas + problem+json
packages/db         Migrações SQL, Drizzle schema, adapters, RLS
packages/checkers   T0/T1/T2 checkers
packages/providers  Nominatim, Overpass, Street View, VLM, BrasilAPI, CloudServer
packages/observability  Logger com redação PII + métricas
packages/testing    Testcontainers + fixtures + dataset dourado
packages/sdk        Cliente TypeScript gerado do OpenAPI
policies/          Políticas de scoring versionadas (YAML)
docs/adr/           14 ADRs
docs/lgpd/          Mapa de dados, RIPD, retenção, LIA
docs/runbooks/      5 runbooks operacionais
infra/              Terraform + k8s como código-alvo documentado
load/               k6 scenarios
```

## Segurança

- **Documentos**: nunca em claro — HMAC-SHA256 com chave por tenant
- **RLS**: FORCE em todas as tabelas com tenant_id
- **Logs**: redator central com testes anti-vazamento no CI
- **API keys**: HMAC-SHA256 (sem argon2), prefix 12 chars
- **Webhooks**: HTTPS only, HMAC-SHA256, timingSafeEqual, redirect: manual
- **SSRF**: hostname allowlist + private range block
- **LGPD**: DELETE /v1/subjects/:id (eliminação transacional), contestação com reason cifrada
- **pgfence**: gate de migrações no CI (lock analysis, risk scoring)
