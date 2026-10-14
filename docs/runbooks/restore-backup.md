# Runbook: restore de backup (Postgres)

**Cenário**: corrupção/drop acidental; DR (RPO ≤ 5 min, RTO ≤ 30 min — alvo de produção).

## Perfil local (dev, zero-custo)

O compose persiste `pgdata` num volume; não há PITR local. Recuperação = volume + dumps manuais:

```bash
docker compose exec postgres pg_dump -U postgres comprova > backup-$(date +%F).sql
docker compose exec postgres psql -U postgres comprova < backup-2026-10-14.sql
```

- **Volume**: `docker volume inspect comprova-endereco_pgdata` — backup do volume = backup do banco.
- **Migrações**: `pnpm db:migrate` recria schema em banco vazio; **dados de referência**
  reconstroem via ingestor; dados de validação são efêmeros por design (`expires_at`).
- **Evidências**: no volume `objectdata` (CloudServer `S3_BACKEND=mem` — **dev não persiste
  objetos entre recriações do container**; para dev persistente, trocar para `S3_BACKEND=file`).

## Alvo de produção (documentado, ADR-0001)

- Aurora PostgreSQL com backups contínuos + PITR (RPO ~5 min); restore via
  `aws rds restore-db-cluster-to-point-in-time`.
- Cross-region snapshot copy diário (dr da seção 11 da spec).
- **Testar trimestralmente** (exigência da spec): restaurar em staging e rodar
  `pnpm test` de integração + smoke da API contra o cluster restaurado.

## Pós-restore

1. `pnpm db:migrate` (idempotente).
2. `pnpm seed:golden` se dev; ingestão real se prod.
3. Smoke: `curl /readyz` + uma validação dourada de cada veredito.
4. Verificar jobs: retention (evidence + validation) e publisher ligaram com o banco novo.
