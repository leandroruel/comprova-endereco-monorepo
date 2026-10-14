# PROGRESS.md

Estado: **Projeto completo (F0–F6, perfil zero-custo)** (2026-10-14) — 102/102 testes

## Feature flag do step de IA (VLM) ✅ (2026-10-14)

- **`VLM_ENABLED`** (default **false**): controla se o deep path inclui o checker de IA
  `street_view_vlm` (T2). → pipeline passa pelo check de visão (requer
  `OPENAI_API_KEY`/`GOOGLE_STREET_VIEW_KEY` para classificar; sem chaves vira `unknown`);
  → T2 vazio, deep path **100% determinístico** (T0 local + T1 geocode/grafo).
  Gate no `buildT2Checkers` (`apps/worker/src/activities.ts`), testado em
  `apps/worker/src/vlm-flag.test.ts` (3/3).

## Fase 6 — Produção e escala (pacote zero-custo) ✅

- **Job de expiração** de validações (`expires_at`): `validationRetentionTick` no worker
  (DB admin), remove validações+sinais+idempotência vencidas com auditoria
  `validation.expired` — pendência da política de retenção resolvida.
- **Runbooks** (`docs/runbooks/`): provedor externo fora, ingestão falhou, fila acumulando
  (deep/batch), restore de backup, incidente de vazamento de PII.
- **k6 real** (`docs/load-report.md`): SLO do fast path **garantido até ~150 rps por
  processo** (p95 = 21–29ms @ 100–150 rps; 100% checks). **3 bugs reais encontrados e
  corrigidos pelo teste de carga**: (1) Idempotency-Key <8 chars → 400 em massa; (2)
  **deadlock de pool** — leituras dos checkers dentro da transação esgotavam a pool com txs
  abertas (fast path reestruturado: leituras fora da tx → tx curta de escrita; `lock_timeout`
  em todo `withTenant`; singleflight por building_key/doc_hmac — coalescing da spec 10.1);
  (3) teto de ~30 rps por argon2 → cache L1 de chaves verificadas (TTL 60s). Pool
  configurável (`DB_POOL_MAX`). Extrapolação honesta: 3k rps ≈ 20 réplicas em infra dedicada.
- **SDK TypeScript** (`packages/sdk`): tipos gerados do OpenAPI 3.1 (`schema.d.ts` via
  openapi-typescript, script `pnpm --filter @comprova/sdk generate`) + cliente `createClient`
  com `SdkError` (código de domínio), idempotency header, timeouts; testes com fetch fake.
- **Terraform + k8s como código-alvo documentado** (`infra/`): módulos network/eks/aurora/
  redis/s3-kms + manifests api (HPA por RPS — `averageValue: 150` derivado do k6, PDB) e
  worker (spot tolerante). Nunca aplicados (ADR-0001); checklist de promoção no
  `infra/README.md`.
- **Capacidade** (`docs/capacidade.md`): medições + estimativas por tabela com o dump real.

## Resumo geral do projeto

| Fase                    | Estado | Gate-chave                                                               |
| ----------------------- | ------ | ------------------------------------------------------------------------ |
| 0 Fundação              | ✅     | RLS multi-tenant testada; 1 comando sobe tudo                            |
| 1 Fast path CNPJ        | ✅     | Dourado T0 8/8 (100% ≥ 85%)                                              |
| 2 Deep path             | ✅     | Caos: provider fora → unknown, sem veredito falso; E2E Temporal real     |
| 3 VLM fake-first        | ✅     | T2 < 25% no dourado; rubrica+eval no CI (gate real ≥200 imgs = com keys) |
| 4 Grafo + shadow        | ✅     | CTE partner_graph < 500ms; simulador de políticas                        |
| 5 CPF + LGPD            | ✅     | Direitos do titular + zero-PII em logs (gate) + docs lgpd                |
| 6 Produção (zero-custo) | ✅     | k6 real com SLO até 150 rps/pod; runbooks; SDK; infra-alvo               |

## Adiadas por design (precisam de $ ou dumps)

- Dump real da Receita/CNEFE (download do mantenedor em andamento): ingestão completa +
  `ref_receita_municipio` real + batch `address_profile` + k6 em escala + EXPLAIN anexado.
- Chaves OpenAI/Street View: checker T2 real + dataset rotulado ≥200 fachadas.
- Conta AWS: aplicar Terraform, canário, DR cross-region, soak 3k rps em staging.
- Temporal com persistência Postgres (dev usa `start-dev` ephemeral — ok em dev).
