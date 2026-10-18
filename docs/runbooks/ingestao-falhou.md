# Runbook: ingestão falhou

**Sintomas**: `ingestor receita:estabelecimentos` com erro; `snapshot_month` desatualizado;
`registry_status` retornando `unknown not_in_registry` em CNPJs válidos.

## Como os dados são carregados (leia antes de agir)

- `ref_receita_estabelecimento` é atualizada **no lugar**:
  `INSERT ... ON CONFLICT (cnpj_basico, cnpj_ordem, cnpj_dv) DO UPDATE` — o conteúdo anterior da
  linha é sobrescrito. **Não existe cópia por snapshot.**
- `snapshot_month` é **proveniência por linha**: guarda o mês do lote que tocou a linha por
  último e é sobrescrito a cada nova ingestão. **Não é chave de partição e nenhuma query filtra
  por ele** — o fast path filtra apenas `situacao_cadastral = 2`
  (`packages/db/src/adapters.ts`).
- Consequência: uma carga parcial é **servida imediatamente**. Linhas já reprocessadas carregam o
  snapshot novo, as demais mantêm o antigo, e as duas aparecem no mesmo resultado.
- Linhas alteradas vão para `ref_estabelecimento_history` (`valid_from`/`valid_to` em meses de
  snapshot). É auditoria do que mudou, **não** um snapshot restaurável.
- O snapshot é sempre explícito: `--snapshot YYYY-MM` é **obrigatório** (não há default).

## Diagnóstico

Só leitura: nada nesta seção altera base. Em particular, **não** rode a ingestão
"para ver o erro" — ela grava o `--snapshot` informado nas linhas que tocar e, com
um mês que não é o do arquivo, deixa proveniência errada. A receita de reingestão
está em "Ações".

```bash
psql $DATABASE_ADMIN_URL -c "SELECT snapshot_month, COUNT(*) FROM ref_receita_estabelecimento GROUP BY 1 ORDER BY 1"
psql $DATABASE_ADMIN_URL -c "SELECT COUNT(*) FROM ref_receita_estabelecimento WHERE situacao_cadastral = 2"
psql $DATABASE_ADMIN_URL -c "SELECT valid_from, valid_to, COUNT(*) FROM ref_estabelecimento_history GROUP BY 1, 2 ORDER BY 1 DESC LIMIT 10"
```

Mais de um `snapshot_month` no primeiro comando = carga parcial/mistura de snapshots (ver acima).
Não é estado transitório inofensivo: é dado sendo servido.

## Ações

1. **Reingestão é escrita**: o `--snapshot` é o mês do **arquivo** que está carregando
   (`YYYY-MM`) — é o valor que vai para `snapshot_month` das linhas tocadas, então nunca reuse o
   mês de outro carregamento. Para reproduzir a falha, use o mês correto e um `--limit` pequeno:
   `pnpm --filter @comprova/ingestor start -- receita:estabelecimentos <arquivo> --snapshot <YYYY-MM> --limit 1000`.
2. **Arquivo inválido/encoding**: o column-map (`COLUMN_MAP` no
   `apps/ingestor/src/receita-estabelecimentos.ts`) assume o layout oficial de Estabelecimentos
   (23 colunas, `;`). Validar header com `head -1 <arquivo> | tr ';' '\n' | wc -l` (deve dar 23).
   Layout mudou? Ajustar o map — **não** improvisar parse manual.
3. **Conflito de PK**: o upsert tem como alvo `(cnpj_basico, cnpj_ordem, cnpj_dv)`; duplicidade no
   dump é absorvida pelo `ON CONFLICT`. Não existe "swap de snapshot" — não há o que falhar no
   meio de uma troca.
4. **Carga interrompida**: reexecutar com o **mesmo `--snapshot`**. O upsert é idempotente, mas as
   linhas não processadas ainda servem o snapshot anterior (ver "como os dados são carregados").
   Quando o reexecutar terminar, conferir o `GROUP BY snapshot_month` do diagnóstico.
5. **Performance**: ingestão completa do dump real ainda é gate adiada (dump em download).
   Se > X horas (X a definir com o dump real): partir por UF (`--limit` por chunks de arquivo)
   em janelas separadas.
6. **Pós-ingestão**: recomputar `address_profile` (job da F1-pendente com dump real) e rodar
   `policy:simulate` se a política de scoring mudar de peso com dados novos.

## Rollback

Não há rollback por snapshot: as linhas foram sobrescritas no lugar.

- `ref_estabelecimento_history` guarda a versão anterior **apenas das linhas cujo conteúdo mudou**
  (com `valid_from`/`valid_to`). Serve para auditar o que mudou, não para restaurar a base.
- Para voltar o conteúdo: reingerir o dump anterior com o `--snapshot` do mês correspondente
  (o upsert é idempotente) ou restaurar backup base. Linhas presentes no dump atual e **ausentes**
  no anterior não são removidas por reingestão.
- `address_profile.computed_from_snapshot` diz de qual snapshot os perfis vigentes derivaram;
  recomputar depois de reingerir.
- Proveniência vigente de cada base: `GET /v1/meta` (exige API key) devolve
  `snapshot_month`/`census_year`/`updated_at` por tabela.
