# Runbook: ingestão falhou

**Sintomas**: `ingestor receita:estabelecimentos` com erro; `snapshot_month` desatualizado;
`registry_status` retornando `unknown not_in_registry` em CNPJs válidos.

## Diagnóstico

```bash
pnpm --filter @comprova/ingestor start -- receita:estabelecimentos <arquivo> --limit 1000
psql $DATABASE_ADMIN_URL -c "SELECT snapshot_month, COUNT(*) FROM ref_receita_estabelecimento GROUP BY 1"
psql $DATABASE_ADMIN_URL -c "SELECT COUNT(*) FROM ref_receita_estabelecimento WHERE situacao_cadastral = 2"
```

## Ações

1. **Arquivo inválido/encoding**: o column-map (`COLUMN_MAP` no
   `apps/ingestor/src/receita-estabelecimentos.ts`) assume o layout oficial de Estabelecimentos
   (23 colunas, `;`). Validar header com `head -1 <arquivo> | tr ';' '\n' | wc -l` (deve dar 23).
   Layout mudou? Ajustar o map — **não** improvisar parse manual.
2. **Conflito de partição/PK**: ingestão usa `onConflictDoNothing`; se houver duplicidade no
   dump, ok. Se o swap de snapshot falhar no meio: o runner de migrações é transacional; a
   ingestão de linhas é idempotente (reexecutar).
3. **Partial ingest (carga caiu)**: reexecutar — batches de 5k com `onConflictDoNothing`
   tornam o reprocessamento seguro.
4. **Performance**: ingestão completa do dump real ainda é gate adiada (dump em download).
   Se > X horas (X a definir com o dump real): partir por UF (`--limit` por chunks de arquivo)
   em janelas separadas.
5. **Pós-ingestão**: recomputar `address_profile` (job da F1-pendente com dump real) e rodar
   `policy:simulate` se a política de scoring mudar de peso com dados novos.

## Rollback

Não há rollback de dados públicos: o snapshot anterior coexiste por `snapshot_month`; queries
do fast path filtram `situacao_cadastral = 2` do snapshot corrente.
