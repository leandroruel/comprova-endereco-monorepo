# ADR-0002: Eventos via Transactional Outbox + porta EventBus

## Status

Aceito (2026-10-10)

## Contexto

O pipeline precisa emitir eventos (`validation.completed`, webhooks, metering) de forma confiável,
sem dual-write (gravar no Postgres e publicar em fila podem divergir). A spec sugere SQS/SNS como
default com Kafka/Redpanda como alternativa, mas não há AWS no perfil zero-custo.

## Decisão

- **Transactional Outbox** no Postgres (tabela `outbox` já criada na migração 0006, com índice
  parcial para não publicados).
- **Porta `EventBus`** (`publish(event)`), definida em `packages/core`, com adapter
  **in-process** para dev/local (publisher lê o outbox e entrega aos handlers/webhooks locais).
- Adapter SQS/SNS fica como código futuro, habilitado por configuração — nenhuma mudança no
  domínio quando entrar.
- Webhooks assinados (HMAC-SHA256, `X-Signature`, `X-Timestamp`, janela anti-replay) chegam na
  Fase 2 e consomem o mesmo fluxo de outbox→publisher.

## Alternativas rejeitadas

- **Kafka/Redpanda agora:** custo operacional e de máquina local sem necessidade atual; o
  outbox + adapter já dão a semântica de "pelo menos uma vez" com idempotência no consumidor.
- **Publicar direto na rota HTTP:** dual-write clássico, perde eventos em falha entre commit e
  publish.

## Consequências

- Garantia de entrega "at-least-once"; consumidores precisam ser idempotentes (já planejado para
  webhooks, que têm tabela de delivery com tentativas).
- O publisher in-process é suficiente para dev; em produção com múltiplos pods, o publisher vira
  um job/worker dedicado (mesma tabela, `SELECT ... FOR UPDATE SKIP LOCKED`).
