# Política de Retenção

Cada classe de dado tem retenção própria, enforceada por job/campo — não por promessa.

## Tabelas de domínio

| Dado                     | Mecanismo                                  | Valor                                                                               |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `validation`             | `expires_at` (NOT NULL)                    | 30 dias; job diario (TODO F6) apaga/arquiva expiradas; partições mensais detachadas |
| `signal`                 | Partição mensal                            | Detach + arquivamento Parquet após janela de retenção                               |
| `validation_idempotency` | Junto à validação                          | Eliminada na erasure do titular                                                     |
| `subject`                | `DELETE /v1/subjects/{id}` (erasure LGPD)  | Enquanto houver validação associada                                                 |
| `evidence`               | `retention_until` NOT NULL + job no worker | imagem 180d / VLM output 365d; objeto e linha apagados                              |
| `address_signal_cache`   | `expires_at` + TTL por sinal               | Máx. 365d (TTL por checker)                                                         |
| `usage_event`            | Partição mensal                            | 12 meses                                                                            |
| `outbox`                 | Marcado `published_at`                     | Purge com a partição                                                                |
| `audit_log`              | Append-only (GRANTS sem UPDATE/DELETE)     | Indeterminada — trilha de conformidade                                              |

## Jobs

- **Retention (worker)**: `retentionTick` roda a cada hora (evidências vencidas → delete objeto + linha).
- **Partições/expiração (TODO F6)**: job diário de `expires_at` + detach de partições antigas.
- **Erasure**: por evento do titular via API (transacional, com audit).

## Evidências de rua

Imagem só é persistida com `STORE_STREET_VIEW_IMAGES=true` (ToS do Google em revisão);
mesmo ligado, `retention_until` = 180d e o job apaga o objeto. VLM JSON (classificação) = 365d.
