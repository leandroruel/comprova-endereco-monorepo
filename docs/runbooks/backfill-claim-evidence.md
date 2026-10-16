# Plano de backfill: claim + claim_evidence (fase 19)

Status: **planejado — não executar sem aprovação**. Medição atual (dev, 2026-10-16):

```text
validation:     12.535
signal:         87.741  (~7 signals por validação)
claim:               0
claim_evidence:      0
```

Estimativa: 1 validation → 1 claim + ~7 evidências ⇒ ~12,5k claims + ~87k evidências.

## Decisão recomendada

**Não fazer backfill agora.** Validações históricas ficam sem claim: o DTO público
torna `claim` opcional (`claim: null` quando não existir), então consumidores
existentes não quebram. Novas validações nascem com claim/evidência. O custo de um
backfill retroativo só se justifica quando a camada de credenciais existir e
precisar emitir claims sobre validações antigas.

## Se o backfill for necessário (procedure)

1. Migration `0023_claim_backfill.sql` — apenas índices/constraints, sem dados.
2. Backfill idempotente em batches via ingestor CLI (`claims:backfill`):
   - `INSERT INTO claim ... SELECT FROM validation v WHERE NOT EXISTS (claim para v)`
     em blocos de 5.000 por `created_at`, `ON CONFLICT DO NOTHING`;
   - evidências derivadas de `signal` existente: `INSERT INTO claim_evidence ...
SELECT FROM signal s JOIN claim c ON c.validation_id = s.validation_id
WHERE NOT EXISTS (...)`, com checkpoint (última `created_at` processada em
     tabela `_backfill_progress`);
   - stance `neutral → unknown`;
   - `expires_at = observed_at + ttl_seconds`.
3. Sem locks longos: `lock_timeout=5s`, `statement_timeout` por batch, batches
   pequenos; fast path não é bloqueado (claims novos convivem com o backfill via
   `ON CONFLICT DO NOTHING`).
4. Monitorar `pg_stat_activity` / locks; retomável após falha pelo checkpoint.
5. Amostra primeiro: rodar 1 batch, validar contagens e RLS, depois o resto.
6. Nunca sobrescrever evidência existente (imutabilidade histórica).
