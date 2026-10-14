# ADR-0007: pgfence como gate determinístico de segurança de migrações no CI

## Status

Aceito (2026-10-10)

## Contexto

As migrações rodam contra Postgres de produção um dia, com tabelas grandes
(`ref_receita_estabelecimento` ~60M linhas, `validation`/`signal` particionadas). DDL que pega
`ACCESS EXCLUSIVE` sem `lock_timeout` pode enfileirar toda a base atrás de um lock — o clássico
incidente de "47 segundos de downtime". A decisão do mantenedor: **pgfence** (`@flvmnt/pgfence`)
como gate **determinístico** no CI do GitHub.

## Decisão

- **Gate**: `pgfence analyze --ci --max-risk medium packages/db/migrations/*.sql` — exit 1 quando
  qualquer statement excede risco MEDIUM, quando há **erro de política**, ou (se ativado no
  futuro) SQL inanalisável. Disponível localmente via `pnpm db:fence` e obrigatório no
  `ci.yml` (passo após `typecheck`, antes dos testes).
- **Versão fixa `0.8.1`** (sem caret) + lockfile com `--frozen-lockfile` no CI: a mesma versão do
  analisador sempre, resultado reproduzível. Alternativa — action `flvmnt/pgfence@v0.8.0` — foi
  preterida em favor da paridade local/CI via devDependency.
- **Telemetria desativada** no repo (`.pgfence.toml`, `telemetry = false`).
- **Conformidade de política**: todas as migrações passaram a abrir com
  `SET lock_timeout = '5s'`, `SET statement_timeout = '60s'`,
  `SET idle_in_transaction_session_timeout = '30s'` e
  `SET application_name = 'comprova-migrations'` — exigidos pelo pgfence e corretos em
  produção (o runner aplica cada arquivo dentro de uma transação; os SETs valem para a sessão).
- **Estado atual do gate** (pós-ajuste): 0 erros de política; maxRisk por arquivo SAFE/LOW,
  exceto 0007 (MEDIUM, pelos `CREATE POLICY`). `--ci` exit 0.
- Limitações aceitas e registradas:
  - DDL dentro de `DO $$ ... $$` (loops de partição hash/mensal, criação de role) não é
    analisável estaticamente → 6 statements dinâmicos, cobertura 95%. O modo estrito
    `--unknown block` **não** é ativado porque esses blocos são permanentes na estratégia de
    particionamento; revisão humana cobre esses trechos.
  - `statement-after-access-exclusive` em 0007 (ENABLE+FORCE RLS de 7 tabelas na mesma
    transação) permanece como _warning_ deliberado: bootstrap em tabelas vazias, transação
    atômica desejável (tudo-ou-nada na habilitação de RLS). Se 0007 fosse reescrito em produção
    com dados, deveria ser separado por tabela.
  - `CREATE INDEX` não-concorrente em tabelas criadas na mesma migração é aceito (tabelas
    vazias; o pgfence já aplica lógica de visibilidade) e roda dentro de transação do runner —
    `CONCURRENTLY` é incompatível com transação.
- **Evolução prevista**: na Fase 6 (infra real), considerar `pgfence trace --ci
--docker-image postgis/postgis:16-3.4` como verificação extra (executa as migrações num
  Postgres descartável e compara os locks reais com a análise estática).

## Alternativas rejeitadas

- **Squawk / Eugene** (SQL linters em Rust): não integram com o fluxo npm/pnpm e o gate precisa
  rodar dentro do mesmo install do CI; pgfence é TS e reusa o toolchain.
- **gate com `--max-risk high`**: aceitaria statements HIGH (ex.: `ALTER COLUMN TYPE`
  cross-family) — teto MEDIUM é o equilíbrio entre segurança e ruído.
- **Supressões em massa (`-- pgfence-ignore`)**: nenhuma supressão foi necessária; se precisar,
  deve ser por statement, com justificativa no PR.

## Consequências

- Migrations perigosas (DROP TABLE, TRUNCATE, ADD COLUMN NOT NULL sem default, ADD CONSTRAINT
  UNIQUE não-concorrente...) quebram o CI antes de existir incidente.
- Toda nova migração deve nascer com o cabeçalho de SETs (o erro `missing-lock-timeout` do
  pgfence força isso).
- Statements dentro de `DO $$` dependem de review; o ADR-0004 (particionamento via script) é o
  controle compensatório.
