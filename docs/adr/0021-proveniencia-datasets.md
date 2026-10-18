# ADR-0021: Proveniência das bases de referência (snapshot explícito + `GET /v1/meta`)

## Status

Aceito (2026-10-18).

## Contexto

As bases de referência são carregadas pelo `ingestor`, mas nada dizia **qual versão** estava
carregada:

- `receita:estabelecimentos` tinha um default silencioso (`--snapshot` ausente →
  `2026-09-01`): uma ingestão sem a flag gravava uma proveniência inventada.
- `receita:municipios` recebia um `snapshotMonth` que **não era persistido** — a tabela
  `ref_receita_municipio` não tem coluna de versão. O parâmetro era um engano: sugeria uma
  proveniência que não existia.
- `ref_receita_estabelecimento` é atualizada no lugar
  (`ON CONFLICT (cnpj_basico, cnpj_ordem, cnpj_dv) DO UPDATE`), com `snapshot_month`
  sobrescrito por linha. **Não há coexistência de snapshots e nenhuma query filtra por
  `snapshot_month`** (o fast path filtra só `situacao_cadastral = 2`). O runbook afirmava o
  contrário nas duas coisas.
- Não existia forma de responder "de que mês é a Receita carregada?", "de que censo é o
  CNEFE?", "quando o CEP foi atualizado?" sem consultar o banco na mão.

## Decisão

### 1. `--snapshot` obrigatório no ingestor

`ingestor receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N]`. O valor é validado
(`^\d{4}-(0[1-9]|1[0-2])$`) e normalizado para o dia 1º (`apps/ingestor/src/cli-args.ts`,
`parseSnapshotMonth`). Sem flag, o comando falha com a razão — não existe default.

### 2. `receita:municipios` deixa de receber snapshot

O parâmetro `snapshotMonth` foi removido de `ingestReceitaMunicipios`: a tabela não tem coluna
de versão e o valor só servia para montar linhas que o `INSERT` descartava. Aceitar um snapshot
que não é gravado mente sobre a proveniência; registrar a versão do município exigiria coluna e
migração, o que não é necessário para operar.

### 3. `GET /v1/meta` (autenticado) expõe a versão de cada base

Novo módulo `apps/api/src/modules/meta/` (schema/controller/service/routes), sob os mesmos hooks
de `/v1` (API key + rate limit). Devolve **só proveniência, nunca conteúdo**:

| Base                                                                        | Versão exposta           |
| --------------------------------------------------------------------------- | ------------------------ |
| `ref_receita_estabelecimento` / `ref_receita_empresa` / `ref_receita_socio` | `snapshot_month`         |
| `ref_cnefe_address`                                                         | `census_year`            |
| `ref_cep`                                                                   | `updated_at` + `sources` |
| `ref_known_shared_address`                                                  | `created_at` + `sources` |
| `address_profile`                                                           | `computed_from_snapshot` |

Sem tabela nova e sem migração: os `GRANT SELECT` de `0008_grants.sql` já cobrem essas tabelas
para `app_user`. Base vazia é `null` explícito — o endpoint não inventa versão
(`ref_receita_empresa`/`ref_receita_socio` ficam `null` enquanto o dump respectivo não for
carregado).

### 4. Cache curto e invalidação

A resposta é cacheada por 5 min (`cacheable`, chave `meta:datasets:v1`) porque `MAX()` sobre uma
coluna sem índice varre a tabela. `cacheKeys.invalidateAll` (usado por
`ingestor cache:flush all`) passou a limpar `meta:*`, para que uma ingestão nova não deixe
proveniência velha em cache.

### 5. Semântica de snapshot documentada

`snapshot_month` é proveniência **por linha** do último lote que tocou a linha, não chave de
partição; carga parcial é servida junto com dados do snapshot anterior. `docs/runbooks/ingestao-falhou.md`
foi reescrito para descrever isso e o rollback real (reingestão do dump anterior ou backup base;
`ref_estabelecimento_history` audita mudanças, não restaura).

## Itens deliberadamente NÃO implementados

- **Registro de execução de ingestão** (`ingest_run`: dataset, arquivo, hash, linhas, status,
  início/fim). É o que tornaria `GET /v1/meta` barato e capaz de representar carga **falha**, mas
  adiciona tabela + migração; fica como próximo passo (issue separada).
- **Índice nas colunas de versão** — só é decisão depois do dump real (custo de índice em dezenas
  de milhões de linhas).
- **Particionamento/coexistência por snapshot** — a base é atualizada no lugar de propósito.
- **Proveniência dentro da credencial** (de qual snapshot saiu o veredito): exigiria binding novo
  no domínio; a credencial continua descrevendo a `validation`, não o dataset.

## Consequências

- "Qual versão está carregada?" passa a ter uma resposta única, autenticada e sem acesso ao banco
  (`GET /v1/meta`), e o ingestor não grava proveniência inventada.
- Limitação conhecida e aceita: as queries de `MAX()` são varreduras completas, amortecidas pelo
  cache de 5 min. Com o dump real carregado, a primeira chamada com cache frio pode demorar — o
  caminho correto é o ledger de ingestão (ou índice), não aumentar o TTL.
- A credencial continua sem declarar em qual base/snapshot o resultado se apoiou; o valor
  permanece aberto e registrado aqui para não ser esquecido.
