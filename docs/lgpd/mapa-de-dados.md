# Mapa de Dados — LGPD (Art. 38, II)

Última atualização: 2026-10-14 · Sistema: comprova-endereco (Address Intelligence API)

## Dados tratados

| Dado                         | Origem                                                | Armazenamento                                                             | Forma                                                                | Retenção                                                             | Base legal típica                                                   |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| CPF/CNPJ consultado          | Request do cliente (tenant)                           | `subject.doc_hmac` (HMAC-SHA256, chave por tenant)                        | **Pseudonimizado** — nunca em claro                                  | Enquanto houver validações; eliminado via `DELETE /v1/subjects/{id}` | Prevenção à fraude (art. 7º, II) / contrato (V) / consentimento (I) |
| Endereço (CNPJ)              | Dump público da Receita Federal                       | `ref_receita_estabelecimento` + `canonical_address` (chaves normalizadas) | Dado público de PJ                                                   | Snapshot mensal; recomputado a cada ingestão                         | Dado público (não-personal)                                         |
| Endereço (CPF)               | Request do cliente, com consentimento (`consent_ref`) | `canonical_address` por `building_key` + chaves                           | Chaves hash + componentes normalizados; **sem complemento de PF**    | Ligado ao ciclo de vida da validação                                 | Consentimento (art. 7º, I) ou contrato                              |
| Nome fantasia / razão social | Dump público RF                                       | `ref_receita_*`                                                           | Claro (dado público de PJ)                                           | Snapshot                                                             | Dado público                                                        |
| Sócios (nome, doc mascarado) | Dump público RF                                       | `ref_receita_socio` (+ `partner_key` hash)                                | Mascaramento original da Receita + hash                              | Snapshot                                                             | Dado público                                                        |
| Sinais de verificação        | Gerados pelo sistema                                  | `signal` (partição mensal)                                                | Fatos sem PII (stance/força/confiança/detalhe)                       | Expira com `expires_at` + partição                                   | Execução do serviço                                                 |
| Evidências (imagem/VLM)      | Google Street View + VLM                              | Object storage + `evidence`                                               | Imagem só com flag `STORE_STREET_VIEW_IMAGES` (ToS); VLM JSON sempre | `retention_until` (180d imagem / 365d output); job de retenção apaga | Execução do serviço                                                 |
| Eventos/outbox               | Sistema                                               | `outbox`                                                                  | Sem PII                                                              | Marcado `published_at`; purge por partição                           | Operação                                                            |
| Webhooks                     | Sistema → endpoints do tenant                         | `webhook_delivery`                                                        | Sem PII; segredo AES-256-GCM                                         | Entrega + retries (≤5)                                               | Operação                                                            |
| Auditoria                    | Sistema                                               | `audit_log` (append-only por grants)                                      | Atores/tipos/IDs — **sem PII**                                       | Indeterminada (trilha de conformidade)                               | Obrigação legal/compliance                                          |
| Uso/metering                 | Sistema                                               | `usage_event` (partição mensal)                                           | tenant + kind + unidades                                             | Partição mensal                                                      | Operação/faturamento                                                |

## Fluxos com dados pessoais

1. **CNPJ (dado público de PJ)**: sem dado pessoal de PF além de sócios já mascarados pela fonte.
2. **CPF**: documento **nunca** persistido em claro (HMAC com chave derivada por tenant);
   endereço do request só com `legal_basis` + `consent_ref`; resposta devolve veredito/sinais —
   nunca dossiê. Logs passam por redator central (testado — gate de CI).
3. **Deep path (Temporal)**: história de workflow carrega apenas IDs + `deep_context`
   (snapshot público do CNPJ). **Nenhum documento transita pelo Temporal.**

## Subprocessadores (perfil atual, local)

- Nenhum dado pessoal sai do ambiente local no perfil zero-custo (Nominatim/Overpass recebem
  apenas strings de endereço público/geográficas — sem CPF/nome). Quando chaves de API forem
  habilitadas: OpenAI (imagem de fachada sem metadados de sujeito) e Google (Street View) —
  atualizar esta seção e a LIA antes de ligar.
