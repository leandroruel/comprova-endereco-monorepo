# comprova-endereco

Address Intelligence API: valida o endereço de um CNPJ (e, na Fase 5, de um CPF consentido)
cruzando múltiplos sinais independentes e devolve um veredito explicável com score de confiança
e trilha de auditoria.

## Quickstart (custo zero — tudo local)

Pré-requisitos: Node 22, pnpm 10, Docker com Compose.

```bash
pnpm install
cp .env.example .env
pnpm start          # docker compose up -d + migrações + seed + API em :3000
```

Serviços:

| Serviço                                                             | Porta       |
| ------------------------------------------------------------------- | ----------- |
| API (`/healthz`, `/readyz`, `/metrics`, `/openapi.json`, `/v1/...`) | 3000        |
| Postgres 16 + PostGIS (com RLS multi-tenant)                        | 5432        |
| Valkey (Redis-compatible)                                           | 6379        |
| Temporal dev server (UI / API)                                      | 8233 / 7233 |
| Object storage S3-compatible (CloudServer)                          | 9000        |

O `pnpm db:seed` imprime a API key do tenant dev **uma única vez** — guarde-a.

```bash
curl -H "Authorization: Bearer cvk..." http://localhost:3000/v1/validations/<id>
```

## Comandos

```bash
pnpm test          # unitários + integração (Testcontainers) + dataset dourado (gate 85%)
pnpm typecheck     # tsc --noEmit em todos os workspaces
pnpm lint          # eslint
pnpm format        # prettier --check
pnpm db:migrate    # aplica migrações SQL versionadas
pnpm db:seed       # legal_basis + tenant dev + API key
pnpm db:fence      # pgfence: gate de segurança de migrações (mesmo gate do CI)
pnpm seed:golden   # semeia o dataset dourado no banco dev (CNPJs, CEPs, CNEFE, perfis)
pnpm compose:down  # para os containers
```

Exemplo de validação (dataset dourado semeado):

```bash
curl -s -X POST http://localhost:3000/v1/validations \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"document":{"type":"CNPJ","value":"12345678000195"},"mode":"fast","legal_basis":"FRAUD_PREVENTION"}'
```

Carga (k6): `API_KEY=... k6 run load/fast-path.js` (threshold p95 < 120 ms).

## Estrutura

```
apps/api            Fastify: auth, rate limit, rotas /v1, health, metrics
apps/worker         Temporal workers (placeholder até a Fase 2)
apps/ingestor       Ingestão Receita/CNEFE/CEP (placeholder até a Fase 1)
packages/core       Domínio puro (FP): Signal/Checker/Stance, validação CPF/CNPJ, helpers async
packages/contracts   Schemas Zod (API) + problem+json (RFC 9457)
packages/db         Migrações SQL (DDL), schema Drizzle tipado, query-builder, withTenant (RLS)
packages/observability  Logger com redação de PII + métricas Prometheus
packages/testing    Testcontainers + fixtures (via Drizzle)
docs/adr            Decisões de arquitetura (query-builder + FP: ADR-0006)
docs/architecture.md Visão geral e alvo de produção
PROGRESS.md         Estado do projeto por fase
```

## Fases

0. Fundação (atual) — monorepo, CI, Compose, schema + RLS, auth, rate limit
1. Dados de referência + fast path CNPJ (dump Receita/CNEFE/CEP, checkers T0, scoring v1)
2. Deep path (Temporal, geocode/Places, webhooks, batch)
3. Mundo físico (Street View + VLM OpenAI)
4. Grafo de sócios e fachadas; simulador de políticas
5. CPF consentido e conformidade LGPD
6. Produção e escala (se houver infra)
