# Política de Retenção

Cada classe de dado tem retenção própria, enforceada por job/campo — não por promessa.

## Tabelas de domínio

| Dado                     | Mecanismo                                   | Valor                                                                                                                                                  |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validation`             | `expires_at` (NOT NULL)                     | 30 dias; `validationRetentionTick` (worker, diário) apaga o grafo; partições são criadas por `ensurePartitions` (detach/arquivamento não implementado) |
| `signal`                 | Partição mensal                             | Tabela particionada; detach + arquivamento Parquet ainda não implementado                                                                              |
| `validation_idempotency` | Junto à validação                           | Eliminada na erasure do titular                                                                                                                        |
| `subject`                | `DELETE /v1/subjects/{id}` (erasure LGPD)   | Enquanto houver validação associada                                                                                                                    |
| `evidence`               | `retention_until` NOT NULL + job no worker  | imagem 180d / VLM output 365d; objeto e linha apagados                                                                                                 |
| `evidence_artifact`      | `retention_until` + expiração da validation | 30d (ciclo da validation); objeto apagado **antes** da linha, antes do grafo; audit `artifacts_removed`                                                |
| `address_signal_cache`   | `expires_at` + TTL por sinal                | Máx. 365d (TTL por checker)                                                                                                                            |
| `usage_event`            | Partição mensal                             | 12 meses                                                                                                                                               |
| `outbox`                 | Marcado `published_at`                      | Purge com a partição                                                                                                                                   |
| `audit_log`              | Append-only (GRANTS sem UPDATE/DELETE)      | Indeterminada — trilha de conformidade                                                                                                                 |

## Jobs

- **Retention (worker)**: `retentionTick` roda a cada hora (evidências vencidas → delete objeto + linha).
- **Expiração (worker)**: `validationRetentionTick` roda diariamente e apaga o grafo `evidence_artifact → claim_evidence → claim → signal → validation` expirado. O objeto do artefato é apagado antes da linha; a auditoria registra `artifacts_removed`.
- **Partições**: `ensurePartitions` cria as partições futuras de `validation`, `signal` e `usage_event`; detach/arquivamento de partições antigas ainda não está implementado.
- **Erasure**: por evento do titular via API (transacional, com audit).

## Documentos de cliente

`evidence_artifact` (F0.1/ADR-0035) guarda somente metadados + `storage_key`;
o binário fica no object storage privado. Ainda **não existe endpoint de
upload**. `retention_until` é o limite contratual, mas a remoção efetiva hoje
acontece quando a validation expira (30d), porque o grafo é apagado como
unidade. Antecipar a remoção por `retention_until` ou manter artefato desacoplado
da validation é decisão de F1.

## Evidências de rua

Imagem só é persistida com `STORE_STREET_VIEW_IMAGES=true` (ToS do Google em revisão);
mesmo ligado, `retention_until` = 180d e o job apaga o objeto. VLM JSON (classificação) = 365d.
