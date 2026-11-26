# Mapa de Dados — LGPD (Art. 38, II)

Última atualização: 2026-11-22 · Sistema: comprova-endereco (Address Intelligence API)

## Dados tratados

| Dado                         | Origem                                                | Armazenamento                                                             | Forma                                                                | Retenção                                                                                             | Base legal típica                                                   |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| CPF/CNPJ consultado          | Request do cliente (tenant)                           | `subject.doc_hmac` (HMAC-SHA256, chave por tenant)                        | **Pseudonimizado** — nunca em claro                                  | Enquanto houver validações; eliminado via `DELETE /v1/subjects/{id}`                                 | Prevenção à fraude (art. 7º, II) / contrato (V) / consentimento (I) |
| Endereço (CNPJ)              | Dump público da Receita Federal                       | `ref_receita_estabelecimento` + `canonical_address` (chaves normalizadas) | Dado público de PJ                                                   | Snapshot mensal; recomputado a cada ingestão                                                         | Dado público (não-personal)                                         |
| Endereço (CPF)               | Request do cliente, com consentimento (`consent_ref`) | `canonical_address` por `building_key` + chaves                           | Chaves hash + componentes normalizados; **sem complemento de PF**    | Ligado ao ciclo de vida da validação                                                                 | Consentimento (art. 7º, I) ou contrato                              |
| Nome fantasia / razão social | Dump público RF                                       | `ref_receita_*`                                                           | Claro (dado público de PJ)                                           | Snapshot                                                                                             | Dado público                                                        |
| Sócios (nome, doc mascarado) | Dump público RF                                       | `ref_receita_socio` (+ `partner_key` hash)                                | Mascaramento original da Receita + hash                              | Snapshot                                                                                             | Dado público                                                        |
| Sinais de verificação        | Gerados pelo sistema                                  | `signal` (partição mensal)                                                | Fatos sem PII (stance/força/confiança/detalhe)                       | Expira com `expires_at` + partição                                                                   | Execução do serviço                                                 |
| Evidências (imagem/VLM)      | Google Street View + VLM                              | Object storage + `evidence`                                               | Imagem só com flag `STORE_STREET_VIEW_IMAGES` (ToS); VLM JSON sempre | `retention_until` (180d imagem / 365d output); job de retenção apaga                                 | Execução do serviço                                                 |
| Eventos/outbox               | Sistema                                               | `outbox`                                                                  | Sem PII                                                              | Marcado `published_at`; purge por partição                                                           | Operação                                                            |
| Webhooks                     | Sistema → endpoints do tenant                         | `webhook_delivery`                                                        | Sem PII; segredo AES-256-GCM                                         | Entrega + retries (≤5)                                                                               | Operação                                                            |
| Auditoria                    | Sistema                                               | `audit_log` (append-only por grants)                                      | Atores/tipos/IDs — **sem PII**                                       | Indeterminada (trilha de conformidade)                                                               | Obrigação legal/compliance                                          |
| Uso/metering                 | Sistema                                               | `usage_event` (partição mensal)                                           | tenant + kind + unidades                                             | Partição mensal                                                                                      | Operação/faturamento                                                |
| Artefato de comprovante      | Upload do Holder / upload de validação                | Object storage privado (S3-compatible) + `evidence_artifact`              | Binário privado; apenas metadados no banco                           | `retention_until` (alinhado à expiração da validation); job de retenção remove objeto antes da linha | Execução do serviço                                                 |
| Consentimento do Holder      | Holder (via link público)                             | `holder_consent`                                                          | Versão dos termos, hash SHA-256 aceito, `accepted_at`, estado        | Imutável após o aceite; eliminado com a validação associada                                          | Consentimento (art. 7º, I)                                          |
| Solicitação do Holder        | Verifier cria; Holder responde                        | `holder_information_request`                                              | Dados de solicitação (tipo, propósito, itens, estado) sem PII direto | Ligado ao ciclo da validação                                                                         | Execução do serviço                                                 |
| Token de acesso do Holder    | Verifier gera; Holder apresenta                       | `holder_access_token`                                                     | Prefixo + HMAC-SHA256 com pepper; sem texto puro                     | Expira em `expires_at`; revogável                                                                    | Execução do serviço                                                 |

## Campos temporais de retenção (migração 0075)

| Campo                | Tabela              | Origem                                         | Significado                                                            |
| -------------------- | ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `document_issued_at` | `evidence_artifact` | Preenchido pelo backend (opcional)             | Data de emissão do documento pelo emissor; nunca inventada ou inferida |
| `received_at`        | `evidence_artifact` | Preenchido no INSERT (backfill = `created_at`) | Data/hora em que o Comprova recebeu e armazenou o documento            |
| `verified_at`        | `evidence_analysis` | Preenchido quando a verificação conclui        | Data/hora em que a verificação do documento foi concluída              |
| `expires_at`         | `evidence_analysis` | `verified_at` + 6 meses (política)             | Data/hora prevista de expiração da evidência                           |

## Fluxos com dados pessoais

1. **CNPJ (dado público de PJ)**: sem dado pessoal de PF além de sócios já mascarados pela fonte.
2. **CPF**: documento **nunca** persistido em claro (HMAC com chave derivada por tenant);
   endereço do request só com `legal_basis` + `consent_ref`; resposta devolve veredito/sinais —
   nunca dossiê. Logs passam por redator central (testado — gate de CI).
3. **Upload de comprovante**: arquivo enviado pelo Holder via upload multipart. O binário
   é gravado em object storage privado (chave `tenants/<tenant>/evidence/<artifact>`),
   com SHA-256 calculado no servidor. O `claim_evidence` é criado com
   `status = pending` (documento recebido, não autenticado). O objeto físico é
   apagado **antes** da linha no banco durante a retenção.
4. **Deep path (Temporal)**: história de workflow carrega apenas IDs + `deep_context`
   (snapshot público do CNPJ). **Nenhum documento transita pelo Temporal.**
5. **Consentimento do Holder**: aceite explícito dos termos validado server-side
   (versão + hash SHA-256 comparados com `TERMS_VERSION`/`TERMS_DOCUMENT_HASH`).
   O upload só é permitido após consentimento válido.

## Locais de processamento e armazenamento

| Serviço            | Plataforma         | Região          | Observações                                                               |
| ------------------ | ------------------ | --------------- | ------------------------------------------------------------------------- |
| API                | Render             | ohio (EUA)      | Web Service, plano free, `autoDeploy: false`                              |
| Redis              | Render KV          | ohio (EUA)      | Vinculado à API via `fromService`                                         |
| Worker (loops)     | Render             | ohio (EUA)      | Configurado em `render.yaml`; estado não confirmado                       |
| Postgres           | Supabase           | us-east-1 (EUA) | Pooler porta 6543, `?sslmode=require`                                     |
| Object storage     | R2                 | não confirmado  | Bucket `evidence` planejado; variáveis S3 não definidas no Render         |
| Dashboard admin    | Cloudflare Workers | — (global)      | `comprova-dashboard.leandro-ruel.workers.dev`; Cloudflare Access pendente |
| Dashboard verifier | Cloudflare Workers | — (global)      | `comprova-verifier-dashboard.leandro-ruel.workers.dev`; público           |

## Subprocessadores (perfil atual, local)

- Nenhum dado pessoal sai do ambiente local no perfil zero-custo (Nominatim/Overpass recebem
  apenas strings de endereço público/geográficas — sem CPF/nome). Quando chaves de API forem
  habilitadas: OpenAI (imagem de fachada sem metadados de sujeito) e Google (Street View) —
  atualizar esta seção e a LIA antes de ligar.
- Cloudflare: hospeda os Workers dos dashboards (proxy e assets estáticos). O Cloudflare Access
  ainda não está configurado para o dashboard administrativo (bloqueador pendente).
- Cloudflare R2: bucket `evidence` planejado para armazenamento de artefatos de comprovante;
  variáveis S3 não definidas no Render — pendente de configuração de credenciais.

## Controles de acesso

- **RLS FORCE** por tenant em `subject`, `validation`, `validation_idempotency`,
  `usage_event`, `webhook_*`, `audit_log`, `batch`, `batch_item`, `claim`,
  `claim_evidence`, `evidence_artifact`, `evidence_analysis`, `holder_consent`,
  `holder_information_request`, `holder_access_token`.
- **API keys** com escopo (`validate:read`, `validate:write`, `keys:write`); aplicação
  via `preHandler` nas rotas mutantes.
- **Better Auth** com instâncias separadas: `admin-auth` (dashboard admin) e
  `verifier-auth` (dashboard verifier), isolamento total de sessões.
- **Cadastro admin desabilitado** (`disableSignUp: true`); usuários só via provisionamento
  (`create-admin`).
- **Cloudflare Access**: pendente de configuração para o dashboard administrativo
  (apenas `leandro.ruel@gmail.com`).

## Exclusão de dados

- `DELETE /v1/subjects/{id}` — erasure LGPD do subject (imutável: `audit_log` preservado).
- Retenção de validação: `validationRetentionTick` (worker, diário) remove o grafo
  `evidence_artifact → claim_evidence → claim → signal → validation_idempotency`
  expirado por `expires_at`.
- Retenção de evidence: `retentionTick` (worker, horário) remove objetos de `evidence`
  vencidos por `retention_until`.
- `holder_consent`: imutável após o aceite; eliminado com a validação associada.
- `holder_access_token`: revogável via `revokedAt`; expira em `expiresAt`.

## Limitações conhecidas

- Artefatos do Holder **sem Validation** ficam com `retention_until` de 30 dias e não
  têm job dedicado de remoção por `retention_until` (limitação documentada).
- `expires_at` de validação é hardcoded em 30 dias, não vem de policy configurável.
- Não há teste de restore em ambiente semelhante à produção (RPO/RTO como alvo, não comprovado).
- Cloudflare Access ainda não configurado para o dashboard administrativo.
- R2/Object storage não configurado (variáveis S3 ausentes no Render).
