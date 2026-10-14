# PROGRESS.md

Estado: **Fase 3 concluída (estrutural), integração aguardando Docker** (2026-10-14)

## ⚠️ Pendência de ambiente

O daemon do Docker (WSL2) caiu durante a validação final da Fase 3. Reexecutar quando voltar:
`pnpm test` (inclui `apps/worker/src/f3.int.test.ts` + suíte completa). Unit/contrato verdes
(47/47), typecheck/lint/format/pgfence verdes sem containers.

## Fase 3 — Mundo físico (Street View + VLM, fake-first) ✅ (sem chaves)

- **Providers**: `StreetViewProvider` (Google real escrito, sem chave → PROVIDER_UNAVAILABLE;
  fake), `VisionModel` (OpenAI gpt-4o real escrito, temperature 0 + JSON estrito Zod; fakes),
  `ObjectStore` (S3/CloudServer + fake). ADR-0012.
- **Checker T2 `street_view_vlm`**: prompt versionado `facade-v1` (sem descrever pessoas),
  rubrica por classes (keywords com fronteira de palavra — bug 'sOBRAdo/OBRA' corrigido),
  stance por classe de fachada, decay de confiança por idade da imagem (1→0.3 em 60 meses),
  evidências (`street_view_image` só com `STORE_STREET_VIEW_IMAGES=true`; `vlm_output` sempre)
  com `evidence_id` no sinal.
- **Orquestração**: T2 só roda se ambíguo após T1 **e** `max_tier >= 2` (flui do POST via
  workflow). Falha de provider → `unknown` (sem veredito falso).
- **Retenção**: job no worker (`retention_until` vencida → objeto + linha apagados).
- **Avaliação**: harness `runFacadeEval` (por classe, accuracy, erros) no CI com modelo fake
  (gate ≥85% por classe). **Gate adiada (com keys)**: dataset real ≥200 fachadas + modelo real.
- **Política 2026.12.1** (peso street_view_vlm 1.2).
- Testes: checker 11/11 (unit), harness, evidência/retenção; integração T2-gating escrita
  (`f3.int.test.ts` — gate <25% no dourado) pendente de Docker.

## Fase 2 — Deep path e evidência externa ✅

### Feito

- **Providers** (`packages/providers`, ADR-0010): Nominatim (geocode), Overpass (places) com
  timeout/abort, fakes p/ testes, `LICENSE_NOTES.md` (ODbL, rate limits, Google futuro).
- **Checkers T1**: `geocode_consensus` (Nominatim × CNEFE, dispersão em metros),
  `places_match` (POIs num raio de 60m vs nome fantasia), `digital_footprint` (DDD vs UF).
  Política `2026.11.1` com pesos T1.
- **Deep path Temporal**: workflow `deepValidationWorkflow` + activity `deepEnrichActivity`
  (retry 3×, 45s); trigger da API via `@temporalio/client` (dedupe por workflowId, degradação
  graciosa se Temporal cai); `deep_context` (migração 0013) — snapshot público do CNPJ para o
  worker nunca precisar do documento; sinais T1 gravados + `address_signal_cache` populado +
  re-scoring + `validation.completed`.
- **Webhooks** (ADR-0011): CRUD `/v1/webhooks`, segredo AES-256-GCM, assinatura
  HMAC-SHA256 (`X-Signature`/`X-Timestamp`, anti-replay 300s), dispatcher outbox com
  backoff exponencial (bug de retry corrigido: falha não-final mantinha pending), guarda SSRF.
- **Batch**: `POST /v1/batches` (≤1000, fast) + `GET /v1/batches/{id}`; claim
  `FOR UPDATE SKIP LOCKED`, validação de dígitos por item, evento `batch.completed`.
- **E2E real validado**: API + worker + Temporal dev no ar → POST deep mode → 202 → workflow
  roda T1 com Nominatim real → validação `completed` com sinais T1 (~12s).
- Caos: providers fora do ar → sinais `unknown`, sem veredito falso (testado).

### Gates

| Gate                         | Estado                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Resiliência em teste de caos | ✅ (provider fora → unknown; Temporal fora → fica partial)         |
| Deep path p95 < 15 s         | ✅ informal E2E (~12s incl. polling); relatório formal no k6 F6    |
| Custo por validação          | 🟡 `usage_event` registra kind fast/deep; relatório de custo na F6 |
| Testes                       | ✅ 76/76 (11 arquivos)                                             |

## Fase 1 — Dados de referência e fast path (CNPJ) ✅

### Feito

- **Canonicalização BR + chaves** (ADR-0008): normalizador puro em TS (abreviações, S/N, KM,
  QUADRA/LOTE com ordenação canônica de pares), `building_key`/`unit_key` sha256 com
  `key_version`; property tests com fast-check (idempotência, estabilidade, equivalência).
- **Migrações 0009/0010**: `ref_receita_municipio` (mapeamento Receita→IBGE, validação com
  nome+UF; pares reais chegam com o dump), `ref_cnae_divisao_categoria`, grants do fast path.
- **Checkers T0** (`packages/checkers`): `document_integrity`, `registry_status`,
  `country_check`, `cep_consistency`, `cnefe_match`, `cotenancy`, `cnae_vs_location` — com
  ports injetáveis (`packages/core/ports.ts`) e adapters Drizzle (`packages/db/adapters.ts`).
  `unknown` ≠ `contradicts` garantido (ausência de evidência não é evidência de ausência).
- **Scoring v1** (ADR-0009): política `policies/2026.10.1.yaml` versionada (Zod no boot),
  hard rules (FOREIGN/NOT_FOUND/INCONSISTENT-baixado), tabela de decisão com hints,
  score `tanh` no contrato, confiança por cobertura+concordância, explicações por template.
- **POST /v1/validations** (fast 200 / deep 202+Location / auto partial-when-ambiguous):
  intake (dígitos, CPF exige endereço → 422, `Idempotency-Key` com tabela dedicada),
  subject resolution CNPJ, upsert de `canonical_address`, pipeline T0, persistência atômica
  (`validation` + `signal`s + outbox + `usage_event` + `audit_log` numa transação com RLS).
- **Dataset dourado T0**: 8 casos rotulados, **gate ≥85% por classe: 100% (8/8)** no CI.
- **Ingestor**: `fixtures` (semente golden no banco dev) e `receita:estabelecimentos <csv>
--limit N` com column-map do layout oficial de Estabelecimentos, chaves calculadas na carga.
- **k6** (`load/fast-path.js`): cenário constant-arrival-rate com threshold p95<120ms.
- ADRs 0008/0009.

### Gates da fase

| Gate                                   | Estado                                                |
| -------------------------------------- | ----------------------------------------------------- |
| Dataset dourado ≥85% nas classes T0    | ✅ 100% (8/8)                                         |
| Testes verdes                          | ✅ (suíte completa)                                   |
| Ingestão completa do dump real (< X h) | ⏸ gate adiada — dump em download                      |
| k6 p95 < 120 ms @ 1k rps               | ⏸ roda contra dump real quando chegar (script pronto) |

### Pendências da fase (com o dump real)

- Validar column-map/`especie` CNEFE com amostra real (suposições nos ADRs 0009).
- Popular `ref_receita_municipio` real e recomputar `municipio_ibge` dos estabelecimentos.
- Batch de `address_profile` (recomputo por building_key após ingestão) + job de partições.
- Medir ingestão completa e rodar k6 em escala (relatório em `docs/`).

## Gate de migrações: pgfence no CI ✅

- `pnpm db:fence` = `pgfence analyze --ci --max-risk medium packages/db/migrations/*.sql`
  (exit 1 bloqueia o CI) — versão fixa `0.8.1`, telemetria off (`.pgfence.toml`).
- Todas as 8 migrações ganharam cabeçalho de política exigido pelo gate (`lock_timeout`,
  `statement_timeout`, `idle_in_transaction_session_timeout`, `application_name`).
- Estado do gate: 0 erros de política; maxRisk SAFE/LOW (0007: MEDIUM por `CREATE POLICY`);
  cobertura 95% (loops `DO $$` de partição não são analisáveis — ADR-0007 registra a revisão
  humana como controle compensatório e `--unknown block` desativado por design).
- CI atualizado: `pnpm db:fence` roda após typecheck, antes dos testes. Ver ADR-0007.

## Refatoração pós-Fase 0 (a pedido do mantenedor) ✅

- **Todo acesso a dados agora usa Drizzle (query-builder)** — ver ADR-0006. Schema tipado
  completo em `packages/db/src/schema.ts` (23 tabelas, enums, `bytea`/`inet`/`geography` como
  custom types); auth, rotas, seed e fixtures migrados de SQL cru para `db.select()/insert()...`;
  `withTenant` reescrito sobre transação Drizzle. Exceções: DDL/migrações (SQL versionado) e o
  runner — documentadas.
- **Programação funcional sem mutabilidade** — zero `let` no código próprio (testes usam
  top-level await com `const`); `map/filter/reduce`/recursão no lugar de loops; objetos por
  spread; `readonly` em interfaces de domínio; helpers `findFirstAsync`/`mapSequential` no core.
  Fronteiras (Fastify, prom-client, test doubles de stream) isentas por documento.
- Gates re-verificados após a refatoração: lint, format, typecheck, **34/34 testes**, smoke
  real da API contra o Postgres do Compose (auth + GET via Drizzle + RLS ativo).

## Fase 0 — Fundação ✅

### Feito

- Monorepo pnpm + Turborepo; TS strict + `noUncheckedIndexedAccess`; ESLint + Prettier; CI
  (GitHub Actions: lint, format, typecheck, test com Testcontainers).
- Docker Compose 1-comando: Postgres 16+PostGIS, Valkey 8, Temporal dev server (UI 8233),
  object storage S3-compatible (Zenko CloudServer; bucket `evidence` criado por init job).
- Schema completo da seção 6 da spec em 8 migrações SQL versionadas: tipos/enums, tenancy
  (`tenant`, `api_key`, `legal_basis`), referência (Receita hash-32, empresa, sócios, simples,
  CNEFE, CEP, known-shared), endereços canônicos + perfil, `subject`/`validation`/`signal`
  (+partições mensais), `validation_idempotency` (idempotência global), `address_signal_cache`,
  `evidence`, outbox, webhooks, `usage_event` particionada, `audit_log`.
- **RLS FORCE** com role dedicada `app_user`, políticas por tenant, grants append-only para
  `audit_log`; helper `withTenant` (`set_config('app.tenant_id', ..., true)`).
- API Fastify 5 + Zod 4: `GET /healthz`, `/readyz`, `/metrics` (prom-client), `/openapi.json`
  (OpenAPI 3.1), `GET /v1/validations/{id}` (ETag/304, RLS por tenant), auth Bearer API key
  (argon2id + pepper, lookup por prefixo), rate limit token-bucket no Redis com headers
  `RateLimit-*`/`Retry-After`, erros RFC 9457, `X-Request-Id`, helmet, CORS fechado,
  graceful shutdown.
- Observabilidade: logger pino com **redação central de PII** (padrões CPF/CNPJ + denylist de
  chaves) e testes anti-vazamento; métricas RED.
- Core: tipos de domínio (`Stance`, `Signal`, `Checker`, `CheckContext`), validação de dígitos
  CPF/CNPJ.
- Testes: **34 testes passando** — unit (doc, redação, logger) + integração (RLS multi-tenant:
  bloqueio de insert sem/cross-tenant, leitura isolada, audit append-only; API: 401/404
  problem+json, isolamento cross-tenant via RLS, ETag/304, 429 com headers).
- ADRs 0001–0005 + `docs/architecture.md` + README.

### Decisões da fase

- Ver ADRs 0001–0005. Destaques: infra zero-custo local (AWS documentada, não provisionada);
  Zenko CloudServer no lugar do MinIO (imagens públicas encerradas) e da R2 (exige cartão);
  migrações SQL manuais (drizzle-kit adiado); idempotência global em tabela dedicada.

### Deixado para depois (por design)

- Migrações continuam SQL manual (partições/RLS/índices parciais não são expressáveis em
  builder) — Drizzle é a camada de **queries** desde já; drizzle-kit segue fora.
- Publisher do outbox (adapter in-process) + `EventBus` como código — Fase 2 (webhooks).
- Job de manutenção de partições (criar futuras, detach/arquivar antigas) — Fase 1.
- OTel/tracing ponta a ponta — Fase 2 (com Temporal).
- `POST /v1/validations` (intake + fast path completo) — Fase 1.
- k6/load tests — Fase 1 (fast path) e Fase 6.
- Revisão de performance do Drizzle no hot path no load test da Fase 1 (ADR-0006).

## Próxima: Fase 1 — Dados de referência e fast path (CNPJ)

1. Fixtures derivados dos **layouts oficiais** (Receita: Estabelecimentos, Empresas, Sócios,
   Simples; IBGE CNEFE) + ingestor CLI (COPY → staging → validação → swap atômico).
   **Gate adiada:** ingestão do dump real (download em andamento pelo usuário) e tempo < X h.
2. Canonicalização BR (libpostal sidecar ou regras próprias) + `building_key`/`unit_key`
   com property tests (idempotência/estabilidade) — ADRs 0006/0007.
3. Mapeamento município Receita→IBGE (ADR-0008).
4. `address_profile` (batch + sob demanda) e checkers T0: `document_integrity`,
   `registry_status`, `country_check`, `cep_consistency`, `cnefe_match`, `cotenancy`,
   `cnae_vs_location`.
5. Scoring v1 (política YAML versionada, hard rules, tabela de decisão) — ADR-0011.
6. `POST /v1/validations` fast + `mode: auto` disparando deep path (stub de workflow).
7. Dataset dourado inicial (classes T0) — gate ≥ 85% nas classes que dependem só de T0.
8. k6 local no fast path (p95 < 120 ms na proporção da máquina).

## Riscos em aberto

- Dumps Reais: download em andamento; desenvolvimento contra fixtures até lá.
- `especie` do CNEFE: confirmar layout oficial antes do checker `cnefe_match`.
- SLOs 3k rps: inválidos de medir localmente — registro honesto no relatório de carga.
- VLM (OpenAI) e Street View exigem crédito/API key na Fase 3.
