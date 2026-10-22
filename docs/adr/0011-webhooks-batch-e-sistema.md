# ADR-0011: Webhooks assinados, batch e componentes de sistema com role admin

## Status

Aceito (2026-10-14)

## Contexto

Fase 2 precisa entregar resultados via webhook (assinados, com retry), processar lotes com
backpressure e manter o padrão outbox. RLS protege `webhook_endpoint`/`webhook_delivery`/
`batch`/`batch_item` por tenant — mas o **dispatcher** e o **processador de lote** são
processos de sistema que precisam operar cross-tenant.

## Decisão

### Webhooks

- CRUD em `/v1/webhooks` (POST/GET/DELETE, escopo do tenant).
- **Segredo** gerado pelo servidor (`whsec_...`), mostrado uma vez, armazenado cifrado com
  AES-256-GCM (chave derivada do pepper; KMS em produção).
- **Assinatura**: `X-Signature` = HMAC-SHA256(secret, `${timestamp}.${body}`) com
  `X-Timestamp` e janela anti-replay de 300s (`verifyWebhookSignature`).
- **SSRF**: desde F0.2, o envio usa `safeExternalFetch` (`packages/providers`):
  resolve/valida todos os IPs, fixa o IP na conexão, exige HTTPS, não segue
  redirect e limita tempo/corpo/content-type ([ADR-0036](0036-guarda-de-fetch-externo.md)).
  `isSafeWebhookUrl` continua no cadastro apenas como validação de UX.
- **Dispatcher** (outbox → deliveries): loop em processo (2s) — `webhook_delivery` recebe
  payload + event_type (migração 0012) para retry independente do outbox. Backoff exponencial
  (2^n × 15s), máximo 5 tentativas → `failed`. Bug corrigido no processo: falha não-final
  mantinha `status='pending'` (antes gravava 'failed' e o retry nunca re-enfileirava).
- **Publisher/batch usam a role admin** (`DATABASE_ADMIN_URL`): são componentes de sistema
  (equivalentes a workers dedicados em produção); as escritas continuam passando por
  `withTenant` para consistência de contexto.

### Batch

- `POST /v1/batches` (até 1.000 itens, apenas mode fast nesta fase; deep fica para o
  processamento individual), resposta 202 + `Location: /v1/batches/{id}`.
- Tabelas `batch`/`batch_item` (migração 0011) com RLS por tenant.
- Processamento: loop (1s) com claim `FOR UPDATE SKIP LOCKED` (Drizzle `.for()`), validação de
  dígitos por item (inválido → `failed/INVALID_DOCUMENT`), idempotência por item
  (`batch:{batchId}:{itemId}`), finalização com evento `batch.completed` no outbox.
- Backpressure: um item por tenant respeita o rate limit interno do loop; escala = mais réplicas
  do loop (mesmo SKIP LOCKED).

## Alternativas rejeitadas

- **Entrega inline na rota**: perde retry e acopla latência da API a endpoints de clientes.
- **`POST /v1/validations:batch` (AIP-style)**: Fastify não suporta pseudo-método; usamos
  `POST /v1/batches` (desvio do contrato documentado).
- **SQS/SNS agora**: sem AWS; o loop com SKIP LOCKED tem a mesma semântica com Postgres.

## Consequências

- Webhook testado E2E com assinatura verificável e caos (fetch falhando → backoff → failed).
- Batch testado E2E: itens válidos viram validações, inválidos falham com código, RLS impede
  leitura cross-tenant.
