# ADR-0012: Fase 3 — Street View + VLM com portas fake-first (sem chaves)

## Status

Aceito (2026-10-14). **Sem chaves de API**: toda a estrutura entregue contra portas com fakes;
adapters reais (OpenAI, Google) escritos e desligados até haver chave/orçamento.

## Contexto

O checker T2 (`street_view_vlm`) precisa de imagem de rua + modelo de visão. Sem cartão, não há
OpenAI/Google agora. O plano aprovado: porta + fake + rubrica prontos, chamada paga pluggável.

## Decisão

### Portas e adapters (packages/providers)

- `StreetViewProvider`: `makeGoogleStreetView` (metadata → data da captura → Static API; sem
  chave → `PROVIDER_UNAVAILABLE`) + `makeFakeStreetView`.
- `VisionModel`: `makeOpenAIVisionModel` (gpt-4o, temperature 0, `response_format: json_object`,
  saída validada por Zod `FacadeClassificationSchema` — classes COMMERCIAL/RESIDENTIAL/VACANT_LOT/
  CONDOMINIUM/CONSTRUCTION/UNKNOWN) + fakes determinísticos + stub que lança (→ unknown).
- `ObjectStore`: S3-compatible (`@aws-sdk/client-s3`, path-style → CloudServer local) + fake.

### Checker T2 (packages/checkers/street-view)

- **Prompt versionado** (`prompts/facade-v1.ts`, `PROMPT_VERSION='facade-v1'`): rubrica fixa,
  JSON estrito, sem descrever pessoas/veículos (privacidade), determinístico.
- **Rubrica** (`rubric.ts`) com exemplos por classe + classificador por keywords com fronteiras
  de palavra (bug corrigido: 'sOBRAdo' casava com 'OBRA').
- Fluxo: ponto (dos sinais geocode/CNEFE) → Street View (sem imagem → `unknown no_imagery`;
  provedor fora → `unknown provider_unavailable`) → VLM → stance por classe (comercial c/ nome
  do sujeito → supports; comercial de outro → contradicts `commercial_other_name`; residencial/
  terreno/obra → contradicts; condomínio → neutral) → **confiança com decay por idade da
  imagem** (fator 1 → 0.3 em 60 meses).
- **Evidência**: `EvidenceWriter` grava imagem (só com `STORE_STREET_VIEW_IMAGES=true` — ToS) e
  sempre o `vlm_output`; `signal.evidenceId` referencia. Rostos/placas: não persistimos recortes;
  o prompt proíbe descrever pessoas — dado sensível tratado por design.
- Worker: writer real (object store + tabela `evidence`, grant na migração 0014) + **retention
  job** (loop: `retention_until` vencida → delete do objeto + da linha).

### Orquestração T2 (gate por ambiguidade)

- `deepEnrich`: T1 → decisão intermediária → **só se ambíguo** (INSUFFICIENT ou confiança <
  0.55) **e** `max_tier >= 2` → T2 → decisão final. `max_tier` flui do `POST /v1/validations`
  (`options.max_tier`, default 2) → trigger → workflow → activity.
- Falha de VLM/Street View → `unknown`, nunca veredito falso (caos testado).
- Política `2026.12.1` (peso `street_view_vlm: 1.2`; decisão inalterada).

### Avaliação (gate de CI)

- Harness `runFacadeEval` (métricas por classe + accuracy + erros) rodando no CI com modelo
  fake sobre `eval-data/labels.sample.json` — **gate por classe ≥ 85%**.
- **Gate adiada (com chaves)**: dataset rotulado real ≥ 200 imagens de fachadas BR +
  acurácia do modelo real por classe (o harness já é o executor; faltam os dados).

## Alternativas rejeitadas

- **Abrir mão do T2 sem chaves**: o gate estrutural (gating, evidência, retenção, rubrica)
  é construível e testável agora; só o dado visual é adiável.
- **Persistir imagens por padrão**: ToS do Street View restringe armazenamento; flag off.

## Consequências

- Com keys: setar `GOOGLE_STREET_VIEW_KEY` + `OPENAI_API_KEY` no worker — nenhum código muda.
- Gate "T2 em < 25% das validações": medido no dourado (só o caso ambíguo dispara) — teste de
  integração escrito, pendente de re-execução com Docker (ver PROGRESS).
- `deep-enrich.int.test.ts` (F2) e `f3.int.test.ts` aguardam daemon Docker para revalidação
  completa; testes unitários e de contrato todos verdes (47/47 sem containers).
