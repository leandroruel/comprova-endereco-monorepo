# comprova-endereco

Address Intelligence API: valida o endereço de um CNPJ/CPF cruzando múltiplos sinais (Receita Federal, CNEFE/IBGE, CEP, co-tenância, geocoding, fachada) e devolve um veredito explicável com score de confiança e trilha de auditoria.

## Quickstart

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
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

## Dashboard

Abre `http://localhost:5173`:

1. Cria conta (email/senha)
2. Valida CNPJ individual ou cria lote (CSV drag & drop / textarea)
3. Vê stats por usuário, vereditos com sinais, export CSV/JSON

## Endpoints da API

| Método          | Path                                      | Descrição                                       |
| --------------- | ----------------------------------------- | ----------------------------------------------- |
| POST            | `/v1/validations`                         | Valida um CNPJ/CPF (fast/auto/deep)             |
| GET             | `/v1/validations/:id`                     | Consulta resultado com ETag                     |
| POST            | `/v1/validations/:id/contest`             | Contestação (art. 20 LGPD)                      |
| GET             | `/v1/stats`                               | Stats por usuário (total, únicos, por veredito) |
| POST            | `/v1/batches`                             | Cria lote (background)                          |
| GET             | `/v1/batches`                             | Lista lotes do usuário                          |
| GET             | `/v1/batches/:id`                         | Detalhes do lote                                |
| GET             | `/v1/batches/:id/export?format=csv\|json` | Download                                        |
| POST/GET/DELETE | `/v1/webhooks`                            | Gestão de webhooks (HMAC)                       |
| GET/DELETE      | `/v1/subjects/:id`                        | Relatório de acesso / eliminação LGPD           |
| GET             | `/healthz` / `/readyz` / `/metrics`       | Ops                                             |
| GET             | `/openapi.json`                           | OpenAPI 3.1                                     |

## Comandos

```bash
pnpm dev          # tudo (API, dashboard, worker, ingestor)
pnpm test         # suíte completa (projetos `node` e `dashboard`)
pnpm test:browser # só os testes de componente, no Chromium real
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm format       # prettier
pnpm db:migrate   # aplica migrações SQL
pnpm db:seed      # tenant dev + API key
pnpm db:fence     # pgfence: gate de segurança de migrações
pnpm seed:golden  # dataset dourado (8 classes de veredito)

# Ingestores
pnpm --filter @comprova/ingestor start -- receita:estabelecimentos <csv> [--limit N]
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
`pnpm install`, por não estar entre os `onlyBuiltDependencies`):

```bash
npx playwright install chromium   # uma vez por máquina; no CI é um passo do workflow
```

Os testes de componente não carregam a folha de estilo (Tailwind), então
asserções de visibilidade valem para elementos com caixa própria — cor e
espaçamento não são testados.

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
