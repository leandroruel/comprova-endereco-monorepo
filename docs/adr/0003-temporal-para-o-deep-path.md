# ADR-0003: Temporal para o deep path (self-hosted)

## Status

Aceito (2026-10-10)

## Decisão

- O deep path (checkers T1/T2, geocode, Places, VLM) roda em **workflows Temporal** com SDK
  TypeScript: workflows determinísticos, chamadas externas apenas em Activities, task queues
  separadas por tier (`t1-io`, `t2-heavy`), retry/circuit breaker/token-bucket por provedor
  nos Activities.
- **Self-hosted em dev** com `temporal server start-dev` (container `temporalio/admin-tools:1.27.0`,
  UI em `:8233`, API em `:7233`). Sem persistência durável em dev (aceitável); a persistência
  (Postgres) será avaliada na Fase 2 junto com o worker.
- Cada `validation` grava `workflow_id` para correlação/auditoria; activities são idempotentes e
  deduplicam por `validation_id`.

## Alternativas rejeitadas

- **Temporal Cloud:** pago, exige cartão.
- **Fila ad-hoc (SQS/SQS+DLQ) + state machine manual:** recriaria retries, timeouts,
  continuação e observabilidade de execução que o Temporal dá de graça; a spec já apontava o
  custo de reinventar isso.
- **BullMQ/Redis para orquestração:** apropriado para filas simples, não para pipelines com
  avaliação intermediária e curto-circuito entre tiers.

## Riscos

- `start-dev` perde histórico ao reiniciar o container. Para staging/testes de integração da
  Fase 2, usar o Temporal com persistência Postgres (imagem `temporalio/auto-setup`) ou aceitar
  a perda em dev.
