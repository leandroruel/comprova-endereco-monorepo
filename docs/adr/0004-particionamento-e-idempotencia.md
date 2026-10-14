# ADR-0004: Particionamento, idempotência global e restrições entre partições

## Status

Aceito (2026-10-10)

## Contexto

`validation`, `signal` e `usage_event` crescem por tempo; `ref_receita_estabelecimento` chega na
ordem de dezenas de milhões de linhas (dump da Receita, Fase 1). O Postgres 16 não impõe unique
global em tabela particionada (o índice único deve incluir a chave de particionamento) e não aceita
FK de tabela particionada para tabela particionada.

## Decisão

1. **RANGE mensal** (`created_at`/`occurred_at`) para `validation`, `signal`, `usage_event`.
   Partições criadas por loop `DO $$` nas migrações (mês corrente -2 até +14). Rotina de manutenção
   (criar partições futuras, detach + arquivamento em Parquet) entra na Fase 1 (job do ingestor).
   **pg_partman foi adiado**: não vem na imagem `postgis/postgis` e o particionamento declarativo
   gerido por job é suficiente agora.
2. **HASH(32)** em `ref_receita_estabelecimento` por `cnpj_basico`; índices parciais por partição
   (`building_key WHERE situacao_cadastral = 2`, `cep`, `cnae_principal`) criados via script junto
   com as partições.
3. **Idempotência global** via tabela dedicada `validation_idempotency (tenant_id, idempotency_key)`
   não particionada com PK composta — o índice único da spec sobre a tabela particionada só
   garante unicidade dentro da partição. O índice parcial por partição foi mantido como defesa
   extra.
4. **Sem FK** de `signal.validation_id` → `validation` (FK cross-partition não é suportado);
   integridade lógica via transação e testes. `validation.subject_id` → `subject` tem FK normal.
5. RLS: políticas na tabela-mãe se aplicam às partições (validado por teste de isolamento).

## Consequências

- Ingestão do dump via swap atômico de partição/snapshot sem bloquear leitura (Fase 1).
- Retenção por detach de partição + arquivamento Parquet no object storage.
- `EXPLAIN (ANALYZE, BUFFERS)` das queries quentes será anexado aqui quando o dump real existir.
