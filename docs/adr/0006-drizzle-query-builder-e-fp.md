# ADR-0006: Drizzle como query-builder para todo acesso a dados + convenções de programação funcional

## Status

Aceito (2026-10-10). Substitui, por decisão do mantenedor, a recomendação original da spec
("SQL puro nos caminhos quentes") que constava do ADR-0001.

## Contexto

O mantenedor definiu duas regras de engenharia para o repositório:

1. **Query-builder em vez de SQL cru** — queries de dados legíveis, composáveis e tipadas.
2. **Programação funcional sem mutabilidade** — funções puras, dados imutáveis, sem `let`,
   sem loops com estado acumulado.

A spec original previa `postgres.js` cru nos caminhos quentes por performance. Essa decisão é
revertida em favor de consistência e tipo-segurança.

## Decisão

### 1. Acesso a dados

- **Drizzle ORM (`drizzle-orm@0.45`, driver `postgres-js`) é a única forma de acesso a dados
  do domínio**: `db.select()/insert()/update()/delete()` com schema tipado em
  `packages/db/src/schemas/` (tabelas, enums, `bytea`/`inet`/`geography` como custom types,
  um módulo por domínio).
- Exceções documentadas e deliberadas:
  - **DDL/migrações** continuam em arquivos SQL versionados (partições, RLS, índices parciais
    e `DO $$` loops não são expressáveis em builder) — executadas pelo runner
    (`packages/db/src/runner.ts`), que é infraestrutura de migração.
  - **Ping de health check** (`SELECT 1`) e `set_config('app.tenant_id', ...)` usam
    `sql\`\`` do próprio Drizzle — parametrizados, sem dados de domínio.
  - **Script Lua do rate limit** roda no Redis (não é acesso a dados do Postgres).
- `withTenant` agora abre transação Drizzle e aplica `set_config` dentro dela; RLS segue
  idêntico (testado).
- Hot path: Drizzle compila para SQL com placeholders (prepared statements) — o overhead é
  mínimo; **se o k6 da Fase 1 mostrar quebra do SLO p95, a revisão desta decisão deve considerar
  um seam por porta de leitura**, não voltar a SQL cru espalhado.

### 2. Convenções funcionais

- **Funções puras** e sem efeitos colaterais em todo o domínio (`packages/core`,
  `packages/contracts`, `packages/observability`): `const` + arrow functions, composição
  (`map/filter/reduce`), recursão no lugar de loops (`findFirstAsync`, `mapSequential`),
  construção de objetos por spread (`{...base, ...(cond ? {x} : {})}`), `readonly` em
  interfaces de domínio.
- **Zero `let` no repositório** (verificado por inspeção; `rg '^\s*let '` não retorna ocorrências
  em código próprio). Testes usam `const` com top-level await em vez de `let` + `beforeAll`.
- **Fronteiras isentas (e documentadas como tal):**
  - Framework HTTP (Fastify): registro de plugins/hooks e o request object são portadores
    mutáveis por natureza; handlers permanecem expression-oriented.
  - prom-client: contadores são mutáveis por design da lib; a exposição é funcional.
  - Test doubles de streams (ex.: captura de logs) e o registro de métricas.

## Alternativas rejeitadas

- **Kysely:** query-builder puro (sem schema tipado de tabela); Drizzle dá tipagem de
  colunas/retorno e já era a escolha da spec para queries comuns.
- **Migrations via drizzle-kit:** não suporta partição hash, RLS, índices parciais; SQL manual
  permanece.
- **Estilo OO/imperativo:** contraria a diretriz; mantém-se FP salvo nas fronteiras acima.

## Consequências

- Queries de Fase 1 (checkers T0, ingestão) nascem em Drizzle: `eq/and/isNull/inArray/desc`
  re-exportados de `@comprova/db`.
- Ingestão em massa (COPY de dezenas de milhões de linhas) continuará com `COPY` via
  `postgres.js` no ingestor — é carregamento bruto, não query; será registrado na Fase 1 se
  necessário.
- Revisão de performance obrigatória no load test da Fase 1.
