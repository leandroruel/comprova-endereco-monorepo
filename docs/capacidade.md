# Estimativa de capacidade (rascunho; atualizar com o dump real — gate adiada da F1)

Última atualização: 2026-10-14 · medições do relatório de carga local.

## Medido (dev, 1 processo)

- Fast path: **~150 rps dentro do SLO (p95 < 30ms)**; saturação ~280 rps/pod (pool 50,
  Postgres no mesmo host). Extrapolando para 3k rps (SLO da spec): **~20 réplicas** com
  hardware dedicado + réplica de leitura + PgBouncer — coerente com o HPA `averageValue: 150`
  do manifest-alvo (`infra/k8s/api.yaml`).
- Argon2 (~30 rps sem cache) resolvido com cache L1 de chaves (TTL 60s) — ver
  `docs/load-report.md`.

## Estimado com o dump real (quando chegar)

| Tabela                                  |            Linhas |           Disco aprox. (dados+índices) |
| --------------------------------------- | ----------------: | -------------------------------------: |
| `ref_receita_estabelecimento` (hash 32) |              ~60M |                  ~15 GB × ~2,5 ≈ 40 GB |
| `ref_cnefe_address`                     |              ~50M |                                 ~20 GB |
| `ref_receita_socio`                     |              ~25M |                                  ~5 GB |
| `validation`+`signal` (particionadas)   | ~1–5 KB/validação | centenas de MB–GB/mês por tenant médio |

- Working set do fast path (`building_key`, CEP, CNAE) cabe em RAM com `effective_cache_size`
  generoso; queries quentes usam índices parciais (ADR-0004) — confirmar com
  `EXPLAIN (ANALYZE, BUFFERS)` na ingestão real (anexo ao ADR-0004 quando feito).
- Particionamento mensal + arquivamento Parquet mantém `validation`/`signal`/`usage_event`
  com retenção sob controle (docs/lgpd/retencao.md).
