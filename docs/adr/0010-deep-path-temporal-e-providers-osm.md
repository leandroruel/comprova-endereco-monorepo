# ADR-0010: Deep path com Temporal self-hosted e providers OSM (zero-custo)

## Status

Aceito (2026-10-14)

## Contexto

Fase 2 exige o deep path assíncrono (T1: geocode, places, footprint) com resiliência a
provedores externos, e o perfil é zero-custo (sem Google/keys pagas). O documento do sujeito é
pseudonimizado (`doc_hmac`), então o worker não pode re-resolver o CNPJ a partir da validação.

## Decisão

### Orquestração

- **Temporal self-hosted** (compose `temporal server start-dev`, task queue `comprova-deep-t1`).
- Workflow `deepValidationWorkflow` (determinístico) com **uma activity** `deepEnrichActivity`
  (startToClose 45s, retry 3× backoff exponencial) — o núcleo é `deepEnrich` (função pura
  testável sem Temporal). T2 (VLM) entra como activity adicional na Fase 3, condicionada à
  ambiguidade.
- **Trigger**: `POST /v1/validations` com `mode: deep` (202 queued) ou `auto` com resultado
  `partial` inicia o workflow via `@temporalio/client` (workflowId = `deep-{validation_id}`,
  dedupe natural). Se o Temporal estiver fora, o log registra e a validação permanece
  queued/partial — **nunca veredito falso por falha de dependência**.
- `validation.workflow_id` grava a correlação.

### deep_context (novo, migração 0013)

- O fast path persiste em `validation.deep_context` um **snapshot dos campos públicos do CNPJ**
  (estabelecimento: situação, CNAE, fantasia, endereço, chaves em hex, telefone, país) + flag de
  dígitos. O worker reconstrói o `registryRecord` a partir dele — **o documento nunca transita
  pela história do workflow** (importante para CPF na Fase 5: nada de PII no Temporal).

### Providers (zero-custo)

- **Nominatim** (geocode): adapter HTTP com User-Agent próprio, timeout 8s, 1 req/s esperado —
  T1 roda só em validações ambíguas + cache `address_signal_cache`.
- **Overpass** (places): POIs nomeados num raio de 60m; timeout 15s.
- `geocode_consensus`: consenso entre Nominatim e **coordenadas do CNEFE** (segundo "provedor"
  gratuito) — dispersão ≤100m supports, >500m contradicts (providers_disagree).
- `places_match`: POI com nome similar ao fantasia → supports; POIs sem match → neutral;
  sem POIs → unknown.
- `digital_footprint`: DDD do telefone vs UF (mapa local) — WHOIS .br adiado (sem acesso
  programático legítimo simples).
- Falha de provider (timeout/HTTP ≠ 200/ rede) → `null`/`[]` → sinal `unknown`. Caos testado.
- `LICENSE_NOTES.md` em `packages/providers` (ODbL: atribuição, rate limits, o que não
  armazenamos; Google fallback documentado com regras de ToS).

### Política

- `2026.11.1` adiciona pesos dos checkers T1 (decisão inalterada; `required_checkers` continua
  T0-only para não penalizar a confiança do fast path).

## Alternativas rejeitadas

- **Google Maps como provedor primário**: pago + ToS de cache; fica como fallback opcional
  documentado.
- **deep_context via re-resolução do documento**: exigiria o CNPJ/CPF claro na história do
  workflow — viola pseudonimização.
- **Fila ad-hoc (BullMQ)**: reinventaria retry/timeout/observabilidade que o Temporal dá.

## Consequências

- Deep path medido informalmente < 15s E2E (workflow completo em segundos; gate formal k6 fica
  para o relatório de carga com infra real).
- E2E validado: POST deep → 202 → workflow → T1 (Nominatim real) → `completed` com sinais novos
  e `address_signal_cache` populado.
- O worker dev (`start-dev`) não persiste história de workflows; aceito em dev.
