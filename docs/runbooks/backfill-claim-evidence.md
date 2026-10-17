# Plano de backfill: claim + claim_evidence (fase 19)

Status: **planejado — não executar sem aprovação**. Medição atual (dev, 2026-10-16):

```text
validation:     23.638  (12.535 ainda sem claim)
signal:        165.462
claim:          11.103
claim_evidence: 77.721
evidence:            0  (nenhum artefato material)
```

Estimativa: ~12,5k claims + ~87k evidências para as validações históricas sem claim.

> Migrações 0024–0027 já foram aplicadas pelo endurecimento de integridade
> (unicidade `claim_evidence (claim_id, signal_id)`, FK composta
> `claim → subject (tenant)`, constraint trigger de `signal` e remoção de
> `validation_idem_uq`). O backfill usa uma **nova** migration (≥ 0028), se precisar
> de DDL.

## Decisão recomendada

**Não fazer backfill agora.** Validações históricas ficam sem claim: o DTO público
torna `claim` opcional (`claim: null` quando não existir), então consumidores
existentes não quebram. Novas validações nascem com claim/evidência. O custo de um
backfill retroativo só se justifica quando a camada de credenciais existir e
precisar emitir claims sobre validações antigas.

## Se o backfill for necessário (procedure)

1. Nova migration (≥ 0028) — apenas índices/constraints, sem dados.
2. Backfill idempotente em batches via ingestor CLI (`claims:backfill`):
   - `INSERT INTO claim ... SELECT FROM validation v WHERE NOT EXISTS (claim para v)`
     em blocos de 5.000 por `created_at`, `ON CONFLICT DO NOTHING`;
   - evidências derivadas de `signal` existente: `INSERT INTO claim_evidence ...
SELECT FROM signal s JOIN claim c ON c.validation_id = s.validation_id
WHERE NOT EXISTS (...)`, com checkpoint (última `created_at` processada em
     tabela `_backfill_progress`);
   - `stance` `neutral → unknown`;
   - `expires_at = observed_at + ttl_seconds`;
   - `claim_evidence_id` é gerado no backfill; a unicidade
     `(claim_id, signal_id)` da 0024 já impede duplicar a mesma observação.
3. **Classificação de `signal.evidence_id` (BAIXO-8) — obrigatória antes de copiar.**
   Historicamente `signal.evidence_id` pode apontar para um `claim_evidence_id`
   (semântica antiga) e **não** para um artefato material. Nunca copiar o valor
   cegamente:
   ```text
   se signal.evidence_id existe em evidence.evidence_id      → material (copiar)
   senão se existe em claim_evidence.claim_evidence_id       → legado (copiar NULL)
   senão                                                     → inconsistente (copiar NULL + logar)
   ```
   O `deep-enrich` já aplica essa regra em runtime (só propaga ids que existem em
   `evidence`); o backfill em massa deve usar a mesma classificação.
4. Sem locks longos: `lock_timeout=5s`, `statement_timeout` por batch, batches
   pequenos; fast path não é bloqueado (claims novos convivem com o backfill via
   `ON CONFLICT DO NOTHING`).
5. Monitorar `pg_stat_activity` / locks; retomável após falha pelo checkpoint.
6. Amostra primeiro: rodar 1 batch, validar contagens e RLS, depois o resto.
7. Nunca sobrescrever evidência existente (imutabilidade histórica).
