# comprova-endereco

Address Intelligence API: valida o endereço de um CNPJ/CPF cruzando múltiplos sinais (Receita Federal, CNEFE/IBGE, CEP, co-tenância, geocoding, fachada) e devolve um veredito explicável com score de confiança e trilha de auditoria.

## Quickstart

Requer Node `^24.22.1`, pnpm 12 (`corepack enable`) e Docker para os serviços
locais. O repo pina `pnpm@12.14.0`; o pnpm 12 aplica uma quarentena de 24h a
releases novas — se o install falhar com
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, veja o
[ADR-0023](docs/adr/0023-pnpm-12-config-de-build-e-quarentena.md).

```bash
cp .env.example .env
pnpm install
pnpm compose:up
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

## Documentação

- [Ambiente e credenciais](docs/ambiente.md) — `.env`, API keys, S3, intake e
  assinatura de credenciais.
- [Arquitetura](docs/architecture.md) — fast/deep path, multi-tenancy, evidências
  e componentes.
- [Roadmap](docs/roadmap.md) — prioridades P0–P3, fases e próximos passos.
- [ADRs](docs/adr/) — decisões de arquitetura.
- [LGPD](docs/lgpd/) — mapa de dados, RIPD, retenção e contestação.
- [Runbooks](docs/runbooks/) — operação e incidentes.

A API expõe o contrato OpenAPI 3.1 em `/openapi.json` com `pnpm dev`.

## API

Autenticação por API key em `Authorization: Bearer <key>`. As rotas `/v1` exigem
`validate:read`, `validate:write` ou `keys:write` (opt-in); o mapa completo está
no [ADR-0030](docs/adr/0030-enforcement-de-scopes-das-api-keys.md).

| Método | Path                                | Descrição                           |
| ------ | ----------------------------------- | ----------------------------------- |
| POST   | `/v1/validations`                   | Cria uma validação (fast/auto/deep) |
| GET    | `/v1/validations/:id`               | Consulta o resultado                |
| POST   | `/v1/validations/:id/evidence`      | Envia comprovante (PDF/JPEG/PNG)    |
| POST   | `/v1/validations/:id/credential`    | Emite a credencial verificável      |
| GET    | `/healthz` / `/readyz` / `/metrics` | Ops                                 |
| GET    | `/openapi.json`                     | Contrato OpenAPI 3.1                |

## Comandos

```bash
pnpm dev              # API, dashboard, worker e ingestor em watch
pnpm test             # suíte completa (Node + browser)
pnpm test:browser     # só testes de componente no Chromium
pnpm typecheck
pnpm lint
pnpm format
pnpm db:migrate
pnpm db:seed          # tenant de dev + API key
pnpm db:fence         # gate de segurança das migrações
pnpm seed:golden      # dataset dourado
pnpm compose:down
```

Para os testes de componente, instale o Chromium uma vez:
`npx playwright install --with-deps chromium` no Linux ou
`npx playwright install chromium` no macOS/Windows.

Os comandos de ingestão e de provisionamento/rotação de chaves estão em
[Ambiente e credenciais](docs/ambiente.md).

## Estrutura

```
apps/api           Fastify: auth, rate limit, rotas /v1, stats, batch, export
apps/dashboard     React + Vite: Better Auth, TanStack Query, bulk search
apps/worker        Temporal workers (deep path T1/T2)
apps/ingestor      CLI: Receita, CNEFE, CEP, profiles, policy:simulate
packages/          core, contracts, db, checkers, providers, credential, sdk,
                   observability e testing
policies/          Políticas de scoring versionadas (YAML)
docs/              Arquitetura, roadmap, ADRs, LGPD e runbooks
infra/             Terraform + k8s como código-alvo
load/              Cenários k6
```

## Segurança

- Documentos e API keys: HMAC-SHA256; logs com redação de PII.
- RLS `FORCE` em todas as tabelas com `tenant_id`.
- Saída externa via `safeExternalFetch` (SSRF, redirect e IP pinning) —
  [ADR-0036](docs/adr/0036-guarda-de-fetch-externo.md).
- LGPD: eliminação em `DELETE /v1/subjects/:id` e contestação auditada em
  `POST /v1/validations/:id/contest`.
