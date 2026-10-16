# Relatório de Carga — fast path (k6)

**Data**: 2026-10-14 · **Ambiente**: dev local (WSL2, 1 processo Node da API, Postgres+PostGIS
em container no mesmo host, pool `DB_POOL_MAX=50`, worker loops ativos) · **Cenário**:
`load/fast-path.js` (POST /v1/validations, mode fast, Idempotency-Key único por iteração,
CNPJ dourado `12345678000195`, 30s constant-arrival-rate) · k6 via imagem Docker
(`grafana/k6`), tráfego pela bridge `172.17.0.1`.

## Resultados

| RPS alvo | RPS real |    avg |    p50 |        p95 | p99* | checks |
| -------: | -------: | -----: | -----: | ---------: | ---: | -----: |
|       40 |     40.0 | 14.8ms | 12.7ms |     33.5ms |    — |   100% |
|      100 |    100.0 | 13.9ms | 11.8ms |   **21ms** |    — |   100% |
|      150 |    149.9 | 16.4ms | 12.3ms | **28.7ms** |    — |   100% |
|      300 |    280.4 |  702ms |  749ms |      1.51s |    — |   100% |

p99 omitido (k6 default oculto no output resumido); disponível em `--summary-export` em
re-execuções futuras.

**SLO fast path (p95 < 120ms): garantido com folga até ~150 rps por processo**, saturando
~280 rps com p95 degradado (fila) em hardware dev compartilhado.

## Achados de engenharia (bugs reais encontrados pelo teste — todos corrigidos)

1. **Idempotency-Key < 8 chars virava 400 em massa** — o script de carga usava
   `k6-${VU}-${ITER}` (< 8) contra o schema `min(8)`. Corrigido para `k6idem-*`.
2. **Deadlock de pool (o achado sério)**: `runFastPath` executava _leituras dos checkers
   dentro da transação_ usando a mesma pool — cada request segurava 1 conexão (tx aberta) e
   pedia outra para os readers; com pool cheia (10 conns), todos esperavam indefinidamente
   (sem `lock_timeout`/acquire-timeout): API travava com `idle in transaction` e deixava de
   responder inclusive smoke tests. **Correção**: fast path reestruturado — leituras sem
   transação → decisão → **transação curta só de escritas**; `SET LOCAL lock_timeout='3s'`
   em todo `withTenant`; **singleflight por `building_key`/`doc_hmac`** (coalescing da spec
   seção 10.1) para upserts concorrentes do mesmo endereço/sujeito.
3. **Teto de ~30 rps por argon2**: verificação argon2id por request é CPU-bound — cache L1
   de chaves verificadas (TTL 60s, máx 5k, invalidação por expiração) elevou o teto para
   ~280 rps (limite da pool/IO).
4. **Pool 10 → 50** (`DB_POOL_MAX`): +~50% de vazão no mesmo hardware.

## Extrapolação honesta para produção (alvo 3k rps, seção 2 da spec)

- 1 processo dev ≈ 150 rps dentro do SLO → **~20 réplicas** da API em hardware dedicado
  (réplica de leitura do Postgres + PgBouncer, pods dedicados, Postgres fora do host da API)
  para 3k rps — coerente com a arquitetura alvo (HPA por RPS, réplica de leitura no fast
  path). Números de produção devem ser re-medidos em infra real (Fase 6 de produção).
- Este relatório NÃO valida: réplica de leitura, múltiplos pods, k6 em máquina separada da
  API/DB — limitações documentadas do perfil zero-custo.

## Como re-executar

```bash
pnpm --filter @comprova/ingestor start load-tenant      # imprime API key sem rate limit
docker run --rm -i -e BASE_URL=http://172.17.0.1:3000 -e API_KEY=<key> -e RPS=150 \
  -e CNPJ=12345678000195 grafana/k6:latest run - < load/fast-path.js
```

> Nota: o argumento do subcomando vai **sem** `--` (`pnpm --filter … start load-tenant`).
> Com `--` o CLI recebe `--` como `argv[2]` e cai no comando `default` (help).

## Re-execução 2026-10-16 — modelo claim/claim_evidence ativo

**Ambiente**: mesmo dev local (WSL2), agora com o pipeline `claim → claim_evidence`
em produção (a9c0dcf) e esta revisão aplicada. `turbo dev` ativo (API + dashboard +
worker). Migração 0023 aplicada. k6 `--summary-trend-stats` com p99 explícito.

|  RPS alvo | RPS real |    avg |    p50 |             p95 |    p99 | checks |
| --------: | -------: | -----: | -----: | --------------: | -----: | -----: |
|        40 |     40.0 | 18.8ms | 17.1ms |          32.8ms | 50.7ms |   100% |
|       150 |    149.9 |   17ms | 16.3ms | **22.2–23.9ms** | 30.9ms |   100% |
| 300 (sat) |    261.0 |  1.02s |  893ms |           1.87s |  1.93s |   100% |

**SLO fast path (p95 < 120ms): mantido com folga no ponto de operação (150 rps)** —
p95 ≈ 23ms, comparável ao baseline de 2026-10-14 (p95 28.7ms). p99 medido em ~31ms.

Ressalvas de medição:

- Ambiente compartilhado tem **alta variância e cold start**. A primeira execução de cada
  ponto é inflada (JIT/caches frios): ex. a 1ª rodada a 150 rps deu p95 39.7ms; em regime,
  22–24ms. Repetições 150 rps: p50 16.3/16.3ms, p95 22.2/23.9ms (estável).
- A 300 rps o sistema satura (~261 rps reais, `dropped_iterations`); os percentis são
  dominados por fila — comparação com o baseline (280 rps, p50 749ms) é dentro do ruído
  e não isola efeito de código.
- O ganho/custo do modelo `claim/claim_evidence` **não é isolável** deste baseline (o
  relatório de 2026-10-14 é anterior ao modelo). No caminho POST, esta revisão não
  adiciona consultas nem round-trips; o único custo novo de escrita é uma checagem de FK
  em `claim.address_id → canonical_address` (o link material em `claim_evidence.evidence_id`
  é nulo no fast path). Alterações de GET/replay não afetam o POST.
