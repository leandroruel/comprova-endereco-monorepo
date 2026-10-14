# Runbook: fila acumulando (deep path / batch)

**Sintomas**: validações presas em `queued`/`partial`; `batch` em `queued` com itens
`pending`; latência de conclusão subindo.

## Diagnóstico

```bash
psql $DATABASE_ADMIN_URL -c "SELECT status, COUNT(*) FROM batch_item GROUP BY 1"
psql $DATABASE_ADMIN_URL -c "SELECT status, COUNT(*) FROM validation GROUP BY 1"
curl -s http://localhost:8233/ >/dev/null && echo "temporal UI ok"
docker compose logs temporal --tail 30
psql $DATABASE_ADMIN_URL -c "SELECT COUNT(*) FROM outbox WHERE published_at IS NULL"
```

## Ações

1. **Worker parado**: reiniciar `pnpm --filter @comprova/worker dev`; conferir log
   `worker listening on task queue comprova-deep-t1`.
2. **Temporal fora**: workflows não iniciam; API degrada (validações ficam `partial` e a
   resposta já foi entregue). Reiniciar o container; workflows deduplicam por
   `deep-{validation_id}` — sem duplicação.
3. **Outbox acumulando** (`published_at IS NULL` cresce): o publisher da API roda a cada 2s;
   se endpoints de webhook estiverem lentos, deliveries re-tentam com backoff (2^n×15s, máx 5).
   Verificar `webhook_delivery.status='failed'` → problema é do cliente (retornos não-2xx).
4. **Batch preso**: `batchTick` processa 5 itens/s/loop; item travado em `processing` (worker
   morto no meio) → reverter manualmente:
   `UPDATE batch_item SET status='pending' WHERE status='processing' AND updated?` — o claim é
   transacional com `SKIP LOCKED`, itens `processing` órfãos precisam desse reset manual.
5. **Backpressure real**: se a taxa de chegada >> processamento, escalar réplicas do loop
   (`WORKER_LOOPS`) — o `SKIP LOCKED` permite múltiplos processadores sem duplicar.

## SLO

Deep path p95 < 15s até `completed`; se p95 > 15s por 15 min, considerar desligar T2
(`max_tier` via request option) até normalizar.
