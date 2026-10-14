# ADR-0009: Scoring v1, hard rules e dataset dourado T0

## Status

Aceito (2026-10-10)

## Contexto

Fase 1 exige veredito explicável com política versionada, sem ML: só sinais, pesos e tabela de
decisão. Todo o raciocínio precisa ser auditável (art. 20 LGPD) e reproduzível.

## Decisão

- **Política YAML versionada** (`policies/2026.10.1.yaml`), validada por Zod no boot
  (`loadPolicy`); cada `validation` grava `policy_version`. Simulador/shadow mode: Fase 4.
- **Score**: `Σ sign(stance) × strength × confidence × decay(idade/ttl) × peso(checker)`.
  O `score` exposto na API é `tanh(score_cru)` — o contrato exige `[-1, 1]` e a soma ponderada
  pode ultrapassar 1; a decisão interna usa o valor cru.
- **Confiança**: `0.35 + 0.4×cobertura + 0.25×concordância×cobertura` (cobertura = checkers
  obrigatórios respondidos; concordância pondera pela cobertura para não inflar confiança com
  1 sinal só). Clamp [0, 0.99].
- **Hard rules** (curto-circuito, ordem da política): `FOREIGN` (país ≠ 105 no registro da
  Receita), `NOT_FOUND` (CEP inexistente na base), `INCONSISTENT` (CNPJ baixado — **suposição
  registrada**: a spec pede "veredito imediato" para baixado/inapto sem dizer qual; escolhemos
  INCONSISTENT quando o endereço existe, revisável no dossiê/revisão humana; inapta entra como
  contradicts 0.6 sem hard rule).
- **Ordem de decisão**: hard rules → hints específicos (`SHARED_VIRTUAL`, `OCCUPIED_BY_OTHER_ENTITY`,
  `RESIDENTIAL` — específico vence genérico) → conflito (suporte e contra ≥ 0.45 ponderados) →
  `CONFIRMED_COMMERCIAL` (score ≥ 0.35 **e** evidência de existência do endereço: `cnefe_match`
  ou `cep_consistency` supports — nunca confirmar endereço só com dígito verificador válido) →
  `INSUFFICIENT_EVIDENCE`.
- `unknown` contribui 0 e reduz cobertura/confiança (ausência de evidência ≠ evidência de
  ausência) — garantido por construção nos checkers (`cnefe_match` ausente = unknown, nunca
  contradicts).
- **Explicações** por templates determinísticos, sem LLM.
- **Categorias de divisão CNAE** (`ref_cnae_divisao_categoria`, migração 0009, ~80 divisões
  CNAE 2.0 — dado público IBGE): `RESIDENTIAL_COMPATIBLE` (62, 69-75, 90-96), `INDUSTRIAL`
  (05-33, 35-43), `COMMERCIAL`, `AGRICULTURAL`, `PUBLIC_SERVICES`, `MIXED`. Curadoria revisável;
  divisão ausente → `MIXED`.
- **`especie` do CNEFE**: assumimos o layout oficial do Censo 2022 (1=domicílio particular,
  2=coletivo, 3+ = estabelecimentos/outras finalidades). **Suposição explícita**: validar
  contra o arquivo real quando o dump chegar (gate adiada); o checker só usa `residential_hint`
  para espécies 1-2.
- **Dataset dourado** (`packages/testing/src/golden.ts`): 8 casos rotulados cobrindo todas as
  classes T0 (comércio confirmado, escritório contábil, ocupado por outro, MEI residencial,
  exterior, CEP inexistente, baixado, sem base local). Gate: **≥85% por classe — atual: 100%
  (8/8)**, bloqueia merge no CI.

## Alternativas rejeitadas

- **Score sem normalização externa:** contrato API exige [-1, 1]; saturação/softmax foram
  rejeitados por perderem magnitude; tanh preserva ordem e monotonicidade.
- **Hint por string mágica no scoring:** hints vivem no `detail.verdict_hint` do sinal, são
  dados, não código — política nova pode ignorá-los sem recompilar checker.
