# ADR-0046: `provider_webhook_event` sem RLS por tenant

## Status

Aceito (2026-11-27). Registro a exceção à convenção de
[`docs/architecture.md`](../architecture.md) ("Isolamento, integridade e
retenção"), que pede RLS FORCE por tenant em tabelas `webhook_*`.

## Contexto

A migration `0094` (PR #85) criou `provider_webhook_event`, o ledger de
idempotência de webhooks de billing (Stripe, e futuros providers). A tabela
não tem `tenant_id`:

- A chave de deduplicação é `(provider_name, provider_event_id)` — o evento é
  do **provider**, não de um tenant. Vários tenants podem aparecer no mesmo
  payload (ex.: eventos de customer diferentes entregues uma única vez).
- O mapeamento evento → tenant é resolvido **em runtime** pelo handler, a
  partir do customer do provider (`tenant.stripe_customer_id`), nunca de dados
  enviados pelo cliente. Forçar RLS por tenant exigiria uma coluna de tenant
  derivada, quebrando a neutralidade do ledger em relação ao provider.
- A tabela não é lida por usuários finais nem exposta em API; é escrita
  exclusivamente pelo handler de webhook.

## Decisão

- **Sem RLS** em `provider_webhook_event`. O controle de acesso é feito por
  grants colunares ao `app_user` (migration `0094`: `SELECT, INSERT`;
  migration `0095`: `UPDATE` restrito a `processed_at`, `processing_error`,
  `retry_count`, `claimed_at`) e `USAGE` na sequence do `id`.
- **Sem `UPDATE` irrestrito**: `app_user` não pode alterar `payload`,
  `provider_event_id` nem `event_type` — o ledger é append-only com
  marcação de estado.
- A leitura por tenant, quando existir (ex.: debug de webhooks no admin),
  passará por uma consulta que resolve o tenant via `tenant.stripe_customer_id`
  com RLS na tabela `tenant` — não por leitura direta deste ledger.

## Consequências

- A convenção "RLS FORCE por tenant em `webhook_*`" passa a ter esta exceção
  explícita; novas tabelas `webhook_*` com `tenant_id` continuam sob RLS FORCE.
- Um evento cujo payload contenha dados de outro tenant permanece visível a
  quem tiver acesso ao banco; mitigado por o payload conter apenas o objeto do
  provider (sem PII além do necessário) e o acesso ao banco ser restrito.
- Se no futuro for necessário isolamento por tenant neste ledger, a migração
  correspondente deve adicionar `tenant_id` resolvido no claim (não no payload)
  e habilitar RLS FORCE — mudança compatível com o claim atômico atual.
