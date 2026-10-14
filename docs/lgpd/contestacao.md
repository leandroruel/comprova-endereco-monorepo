# Fluxo de Contestação (art. 20 LGPD)

O titular (via tenant) pode contestar uma decisão automatizada e pedir revisão humana.

## Fluxo operacional

1. **Contestação**: `POST /v1/validations/{id}/contest` com `reason` (texto do titular).
   - 404 se a validação não pertencer ao tenant (RLS).
   - Grava `audit_log` (`validation.contested`, sem o texto da razão — só o comprimento) e
     evento `validation.contested` no outbox (para fila de revisão/webhook do tenant).
2. **Revisão humana** (procedimento, não código): operador do tenant (ou mantenedor, quando
   aplicável) abre a validação (`GET /v1/validations/{id}` — veredito, `policy_version`, sinais
   com fonte/força/confiança e explicação por template) e avalia os sinais contra o contexto
   declarado pelo titular.
3. **Resultado da revisão**: o tenant responde ao titular pelo seu canal próprio. O sistema
   mantém a trilha (sinais + auditoria) imutável; correções de política seguem o fluxo de
   **simulador de políticas** (`policy:simulate`) antes de qualquer promoção.

## Garantias técnicas de revisabilidade

- `policy_version` imutável por arquivo; sinais nominais com `checker_id@version` e `source`
  (ex.: `receita:2026-09`, `ibge:cnefe`).
- Explicação determinística (templates), não gerada por LLM.
- Auditoria append-only (sem UPDATE/DELETE pela role da aplicação).

## Prazos (política interna sugerida)

- Acusar recebimento: 2 dias úteis. Resolução: 15 dias corridos (alinhado ao art. 19 LGPD).
