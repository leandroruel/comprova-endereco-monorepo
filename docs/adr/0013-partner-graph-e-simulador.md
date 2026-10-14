# ADR-0013: partner_graph local via CTE e simulador de políticas (shadow mode)

## Status

Aceito (2026-10-14)

## Contexto

Fase 4: detectar padrões de fachada (sócios em comum com muitos CNPJs no mesmo endereço, aberturas
em lote) e permitir promover políticas de scoring sem risco (shadow mode). A spec sugeria
backend de grafo dedicado como alternativa — só se as consultas recursivas não atenderem SLO.

## Decisão

### partner_graph (T1 local)

- **Porta** `PartnerGraphReader` (`statsFor(buildingKey, cnpjBasico)`) com adapter Drizzle
  executando **uma query com CTEs** (`db.execute(sql)` — exceção documentada do ADR-0006 para
  agregação complexa): co-localizados ativos no prédio → sócios do sujeito → interseção de
  `partner_key` (contagem de CNPJs co-localizados com sócio em comum) → aberturas nos últimos
  12 meses no prédio.
- Checker `partner_graph` (tier 1, CNPJ): `cnpjsSharingPartner >= 3` OU `recentOpenings >= 5` →
  `contradicts 0.5 / conf 0.6` com `pattern: partner_facade`; sócio compartilhado < 3 → neutral;
  sem dados → unknown. Deep path T1 o executa (fora do hot path).
- **Grafo dedicado (Memgraph/Neo4j) rejeitado por enquanto**: a consulta é uma junção de
  profundidade 1 (sócios diretos), não travessia recursiva — Postgres com índice de
  `building_key` resolve (medido < 500ms no dataset dourado; refinar com dump real).
  A interface permite trocar o backend sem tocar nos checkers.

### Simulador de políticas (shadow mode)

- CLI `ingestor policy:simulate <versao-alvo> [--report]` (`apps/ingestor/src/policy-simulate.ts`):
  replay de `decide()` sobre os **sinais históricos** de cada validação (relógio = `created_at`
  da validação, decay neutro), compara com o veredito armazenado e reporta total/divergentes/
  transições/amostras. `--report` grava JSON em `docs/policy-reports/`.
- Uso: rodar contra a versão candidata antes de promover (ex.: `2027.01.1`), revisar transições,
  então trocar `POLICY_VERSION` e colapsar a política antiga.
- Teste de integração: validação bem fundamentada → sem divergência; validação "falha"
  (armazenada como CONFIRMED com sinais unknown) → divergência reportada com transição.

## Consequências

- Novos pesos de checker exigem política nova + `policy:simulate` antes do `POLICY_VERSION`
  bump — fluxo documentado no README.
- Golden dataset ampliado: 3 CNPJs co-localizados no prédio do escritório contábil compartilhando
  `partner_key` + aberturas recentes (cenário de fachada real para o grafo).
- Fase 4 entregue com 95/95 testes; gates do dourado e T2 <25% mantidos.
