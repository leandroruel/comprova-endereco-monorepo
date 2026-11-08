# ADR-0044: Medição de uso, idempotência, cotas e reconciliação (F3.3)

## Status

Proposta (2026-11-06)

## Contexto

A tabela `usage_event` já existe (migration `0006_events.sql`), particionada por `RANGE (occurred_at)` mensal, com colunas `tenant_id`, `occurred_at`, `kind` (texto livre: `'fast'`/`'deep'`), `units`, `cost_micros`, `validation_id`. Ela é preenchida em dois pontos:

- `apps/api/src/services/fastpath.ts` (linha ~734): `kind: 'fast'`, `units: 1`, após criar uma `validation`.
- `apps/worker/src/modules/deep-enrich/deep-enrich.persistence.ts` (linha ~404): `kind: 'deep'`, `units: 1`, em `emitOutcomeEvents`.

Não há:

- vocabulário estável de tipo de evento (`kind` é texto livre),
- chave de idempotência nem índice único (duplicidade possível em concorrência/retry),
- noção de "evento faturável" separada de "tentativa",
- cotas por tenant (existe `tenant.monthly_quota` no schema, sem uso de cobrança),
- reconciliação entre validações concluídas e eventos de uso,
- endpoints de consulta de consumo/cota.

O roadmap F3.3 define o escopo: contrato de uso, idempotência no banco, regras de faturabilidade, cotas soft/hard, consulta de consumo, reconciliação, endpoints e RLS. Não inclui gateway de pagamento, checkout, notas fiscais ou planos comerciais definitivos.

## Decisões

### 1. Contrato canônico de evento de uso

Evoluir `usage_event` de forma aditiva:

| Coluna            | Tipo    | Descrição                                                             |
| ----------------- | ------- | --------------------------------------------------------------------- |
| `event_type`      | text    | `'technical_execution' \| 'processing_attempt' \| 'usage_event'`      |
| `idempotency_key` | text    | chave de idempotência (não única na tabela particionada; veja item 2) |
| `billable`        | boolean | se o evento é faturável                                               |
| `source`          | text    | origem do evento (ex.: `fast`, `deep`, `nf3e`, `customer_document`)   |

Manter `kind` para compatibilidade com registros históricos. `kind` continua preenchido com `'fast'`/`'deep'`; `event_type` é o vocabulário estável.

### 2. Idempotência no banco

Por `usage_event` ser particionada por `occurred_at` (ADR-0004), um índice único global sobre `idempotency_key` não é possível (índice único em tabela particionada deve incluir a chave de particionamento). Seguir o padrão já usado para `validation_idempotency`:

- Criar tabela dedicada **não particionada** `usage_event_idempotency (tenant_id, idempotency_key)` com PK composta.
- Antes de inserir um evento de uso, tentar inserir na tabela de idempotência dentro da mesma transação.
- `ON CONFLICT DO NOTHING` + verificação de linhas retornadas detecta concorrência: se 0 linhas, outra transação já venceu → buscar o evento existente e tratar como replay (sem duplicar consumo).
- Eventos históricos continuam consultáveis; a coluna `idempotency_key` em `usage_event` aponta para a chave usada.

### 3. Distinção: evento técnico, tentativa de processamento e unidade faturável

São três identidades distintas. Não confundir evento técnico ou tentativa com a unidade de cobrança:

| Conceito                                       | `event_type`          | `billable` | Chave de idempotência                      | Justificativa                                        |
| ---------------------------------------------- | --------------------- | ---------- | ------------------------------------------ | ---------------------------------------------------- |
| Evento técnico (checker)                       | `technical_execution` | false      | própria (aleatória)                        | Passo intermediário, não unidade comercial           |
| Tentativa de processamento (fast não terminal) | `processing_attempt`  | false      | própria (aleatória)                        | Execução técnica (deep enqueue, fast queued/partial) |
| Evento de uso (conclusão faturável)            | `usage_event`         | true       | **`validation:<validationId>` (canônica)** | Unidade comercial consumida (validação concluída)    |
| Conclusão com fonte indisponível               | `usage_event`         | false      | própria (aleatória)                        | Indisponibilidade não é valor entregue               |
| Replay/idempotência (mesma chave)              | `usage_event`         | —          | —                                          | Mesma operação lógica, não duplica consumo           |

**Unidade faturável**: exatamente uma por `tenantId + validationId`, apenas quando a validação atinge status `completed` com resultado faturável. Eventos técnicos e tentativas são registrados separadamente (para auditoria e rastreio) mas nunca duplicam a unidade comercial — por isso NÃO usam a chave canônica: uma chave técnica nunca pode bloquear o faturamento legítimo de uma conclusão posterior. Reprocessamentos e retries com a mesma chave de idempotência retornam o evento previamente registrado (`replayed: true`) sem consumir cota novamente (ADR-0044 § Ordem de idempotência e cota).

#### 3a. Identidade comercial garantida pelo banco (`usage_billing_unit`)

Chaves de idempotência são disciplina de aplicação e não bastam: se fast e deep usassem chaves diferentes para a mesma validação, haveria duas cobranças. A garantia é estrutural, na tabela **não particionada** `usage_billing_unit (tenant_id, validation_id)` com PK composta (criada pela migration `0053`):

1. Ao registrar um evento FATURÁVEL com `validationId`, o serviço transacional (`recordUsageEventInTx`) insere em `usage_billing_unit` com `ON CONFLICT DO NOTHING`.
2. Conflito ⇒ outra execução (fast **ou** deep, com **qualquer** chave) já faturou esta validação ⇒ retorna o evento dela como replay (`replayed: true`), sem consumir cota e sem inserir novo evento.
3. O `event_id` do evento vencedor é escrito na linha da identidade comercial, na mesma transação.
4. A atomicidade (reserva da identidade + verificação de cota + inserção do evento + associação do `eventId`) é garantida por tudo estar na mesma transação, com `SELECT ... FOR UPDATE` no tenant serializando as execuções concorrentes.
5. Eventos não faturáveis (técnicos, tentativas, indisponibilidade) **não** reclamam identidade comercial — não bloqueiam faturamento futuro legítimo.
6. `usage_event` é particionada por `occurred_at` e não aceita constraint única global fora da chave de particionamento (ADR-0004); a tabela auxiliar não particionada é o mecanismo correto.

#### 3b. Política provisória de faturabilidade (conclusão técnica ≠ elegibilidade comercial)

`validation.status = 'completed'` significa conclusão **técnica**; `billable` é elegibilidade **comercial**. Um checker em timeout ou uma fonte externa indisponível produzem validação concluída com evidência `unknown` — e isso NÃO é faturável na política provisória. A política vive em `@comprova/core` (`hasExternalUnavailability` / `unavailabilityCauseOfSignal`) e é aplicada de forma idêntica em fast e deep:

| Causa do sinal `unknown`                                                                                         | Indisponibilidade? | Faturável? |
| ---------------------------------------------------------------------------------------------------------------- | ------------------ | ---------- |
| `source: '<checker>:timeout'` / `reason: checker_timeout`                                                        | sim                | **não**    |
| `reason: source_unavailable` (fonte externa indisponível)                                                        | sim                | **não**    |
| `reason: internal_error` (falha interna de processamento)                                                        | sim                | **não**    |
| `reason: not_in_registry`, `cep_missing`, `address_not_resolved`, `no_profile`, … (checker executou e respondeu) | não                | **sim**    |

- Não há "tudo que é `unknown` é indisponibilidade": a causa é determinada pelo motivo (`detail.reason`/`source`) e o conjunto de motivos de indisponibilidade é fechado e explícito.
- O `validation.status` não é alterado por faturabilidade — são conceitos independentes.
- Evento não faturável por indisponibilidade usa chave de idempotência própria (não a canônica): uma reexecução posterior com as fontes disponíveis pode faturar legitimamente (uma única vez, pela identidade comercial).
- Auditoria: os sinais de timeout/indisponibilidade ficam persistidos (`signal.source`/`signal.detail`), e a reconciliação (§6a) isenta de divergência as validações concluídas que têm esses sinais.

Recomendação inicial (decisão comercial ainda pendente): indisponibilidade de fonte externa, retry e replay **não** geram nova cobrança. A unidade de cobrança provisória é "validação concluída" (1 unidade por `validation` concluída com resultado faturável).

O campo `billable` + `source` tornam a decisão auditável.

### 4. Cotas por tenant

A coluna `tenant.monthly_quota` (bigint) já existe no schema (`packages/db/src/schemas/tenancy.ts`) mas não é utilizada comercialmente.

- **Cota hard**: quando o consumo acumulado no período mais as unidades da
  operação excede `monthly_quota` (`consumido + unidades > monthly_quota`),
  novas operações faturáveis são impedidas (`QuotaExceededError`, HTTP 429).
- **Cota soft**: quando o consumo >= percentual configurável (ex.: 80% do quota), permite continuar mas registra alerta.
- **Período de referência**: mensal, alinhado com `occurred_at` de `usage_event`.
- **Ausência de cota**: `monthly_quota IS NULL` → sem limite comercial (rate limiting técnico continua ativo independente).
- **Auditoria**: tabela `tenant_quota_audit` está criada (migration `0053`) para registrar alterações de `monthly_quota`.
- ⚠️ **Fora de escopo desta fase**: o mecanismo de alteração de `tenant.monthly_quota` (endpoint/administrador para mudar cotas) **não foi implementado**. A tabela `tenant_quota_audit` existe mas ainda não é preenchida por qualquer endpoint. Não apresentar a auditoria como funcionalidade concluída (item 8 da correção PR #63).

### 5. Concorrência no consumo de cotas

Duas requisições simultâneas não podem ultrapassar silenciosamente um limite hard. Usar `SELECT ... FOR UPDATE` na linha do tenant dentro da transação de emissão do evento faturável, garantindo atomicidade entre a verificação de quota e a inserção do evento.

### 5a. Ordem de idempotência e cota (recordUsageEventInTx)

A ordem de operações é intencional e segura sob concorrência:

1. **Reservar/inserir a chave de idempotência** em `usage_event_idempotency` (PK composta `tenant_id + idempotency_key`, `ON CONFLICT DO NOTHING`).
2. **Se for replay** (0 linhas inseridas → chave já existe), retornar o evento previamente registrado **sem** consumir cota novamente (`replayed: true`).
3. **Se for operação nova**, verificar a cota hard (`consumed + units > monthly_quota` → `QuotaExceededError`).
4. **Registrar o evento** em `usage_event` (com `eventId` gerado) e atualizar a referência do evento na linha de idempotência.
5. Tudo permanece na **mesma transação** da operação de negócio correspondente.

A verificação de cota hard ocorre **após** a reserva de idempotência e **apenas** para operações novas (não-replay), de modo que replays nunca sejam rejeitados por cota já consumida.

### 6. Consulta e reconciliação

Serviço de consulta agrega `usage_event` por tenant + período:

- total de eventos, total de unidades, total de unidades faturáveis, custo técnico acumulado, distribuição por `event_type`.

O `total` da paginação de eventos aplica exatamente os mesmos filtros (`tenant_id`, período, `billable`, `event_type`) da consulta de registros (CodeRabbit c).

#### 6a. Regras de comparação da reconciliação

A reconciliação compara **validações concluídas** (selecionadas por `completed_at` dentro do período, não por `created_at`) com **eventos de uso** no mesmo período, e é **somente leitura** (não corrige dados silenciosamente). Regras:

| Divergência                | Condição                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation_without_event` | Validação concluída no período sem nenhum evento de uso associado (qualquer tipo).                                                                |
| `billability_mismatch`     | Validação concluída possui evento(s) de uso, mas nenhum é faturável (`billable = false`). Um evento não-faturável não é evidência de faturamento. |
| `duplicate_event`          | Mais de um evento faturável para a mesma `validationId` (viola a unicidade da unidade faturável).                                                 |
| `unit_mismatch`            | Exatamente um evento faturável, mas as unidades registradas divergem do esperado (1 unidade por validação concluída).                             |
| `event_without_validation` | Evento com `validationId` nulo, ou que referencia validação não concluída no período.                                                             |

Considerações:

- Eventos com `validationId` nulo são reportados como `event_without_validation` (validationId null).
- Múltiplos eventos técnicos para uma mesma validação não geram `duplicate_event` (apenas eventos faturáveis contam).
- Mais de um evento faturável para a mesma validação gera `duplicate_event`.
- A reconciliação compara billing rules (faturabilidade + unidades), não apenas contagem de eventos (CodeRabbit e).
- **Isenção por indisponibilidade (§3b)**: validações concluídas cujos sinais persistidos indicam timeout de checker, fonte externa indisponível ou falha interna são isentas das divergências `validation_without_event`/`billability_mismatch` — a política provisória diz que não são faturáveis. A isenção é auditável pelos sinais; qualquer outro caso de validação concluída sem cobrança continua sendo reportado.

Limitações:

- Não considera eventos de períodos diferentes da validação (apenas janela `completed_at` × `occurred_at` no período informado).
- Não corrige dados automaticamente; cabe ao operador avaliar as divergências reportadas.

### 6b. Backfill histórico (migration 0053)

O histórico **não** é presumido limpo nem deduplicado. Política executada pela migration (transacional, all-or-nothing):

1. Registros históricos sem `event_id` recebem um (`gen_random_uuid()`) — identificador estável para dedup e referência.
2. Qualquer linha `billable = true` fora da regra é rebaixada para `technical_execution`/`billable = false` (validação inexistente, não concluída, de outro tenant ou sem `validation_id`).
3. Para cada `(tenant_id, validation_id)` de validação **concluída**, exatamente UM evento é promovido a canônico: `event_type = 'usage_event'`, `billable = true`, `idempotency_key = 'validation:<validation_id>'` (a mesma chave dos caminhos fast/deep). Escolha determinística (`billable DESC, occurred_at DESC, event_id`). Os demais eventos da mesma validação permanecem técnicos — histórico preservado, não apagado.
4. Os canônicos geram linhas em `usage_event_idempotency` (replay de retries históricos) e em `usage_billing_unit` (identidade comercial no banco).
5. Validações parciais/queued, eventos sem `validation_id` e eventos cross-tenant permanecem `technical_execution`/`billable = false` — não contam no consumo comercial (que soma apenas `billable = true`).

Testado em PostgreSQL real em `apps/api/tests/usage-backfill.migration.int.test.ts` (histórico redundante construído de propósito, migration executada como o runner faria).

### 6c. Estratégia de índices e execução transacional

Os índices sobre `usage_event` (particionada) são criados com `CREATE INDEX` convencional **dentro** da transação da migration. `CREATE INDEX CONCURRENTLY` foi avaliado e descartado: (a) o runner executa cada migration numa transação e o PostgreSQL não aceita `CONCURRENTLY` em transação; (b) `CONCURRENTLY` não é suportado sobre a tabela particionada pai; (c) o volume por partição mensal é pequeno no lançamento da F3.3 e `lock_timeout`/`statement_timeout` limitam o bloqueio — uma falha é retrátil (migration all-or-nothing). Se o volume justificar um dia, o caminho é criar os índices concorrentemente por partição e anexá-los (`ATTACH PARTITION INDEX`) numa migration não transacional; alterar o comportamento global do runner não é necessário agora.

### 7. Endpoints

- `GET /v1/usage/consumption` — consumo por período (unidades, faturáveis, custo, distribuição).
- `GET /v1/usage/quota` — situação da cota (limite, consumido, restante, soft/hard).
- `GET /v1/usage/events` — histórico de eventos de uso.
- `GET /v1/usage/reconcile` — divergências entre validações concluídas e eventos de uso.

Autenticação: tenant resolvido pelo contexto autenticado (sessão ou M2M), scopes explícitos (`validate:read`). Nunca confiar em `tenantId` livre do cliente. Para **sessão de usuário**, `tenantId` é obrigatório no querystring e validado contra a associação do usuário com a organização (`organization_member`); para **M2M**, o tenant vem da API key autenticada e, se `tenantId` vier no query, `requireTenantMatch` exige correspondência (403 caso contrário). Os schemas de query declar `tenantId` explicitamente: o type provider Zod substitui `request.query` pelo objeto parseado e remove propriedades desconhecidas — sem a declaração, o middleware de sessão receberia `undefined`.

### 7a. Contrato canônico compartilhado

O DTO de evento de uso é definido UMA vez em `@comprova/contracts` (`UsageEventDtoSchema`: `eventId`, `tenantId`, `occurredAt`, `eventType`, `kind`, `units`, `costMicros`, `validationId`, `idempotencyKey`, `billable`, `source`) e reutilizado pela resposta HTTP (`UsageEventsResponseSchema`), que inclui `eventId` e `tenantId` — rastreabilidade do evento persistido ao tenant autenticado. Respostas de `consumption`, `quota` e `reconcile` também reutilizam os DTOs compartilhados. Testes validam a resposta HTTP com os schemas compartilhados.

### 8. RLS e segurança

Novas tabelas (`usage_event_idempotency`, `usage_billing_unit`, `tenant_quota_audit`) com `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, políticas `USING`/`WITH CHECK` com `app_tenant_id()`, grants para `app_user`. Testar com role `app_user`.

## Consequências

- `usage_event` ganha colunas aditivas; registros históricos continuam válidos.
- `usage_event_idempotency` é uma tabela nova não particionada.
- `tenant.monthly_quota` passa a ser usada comercialmente (não afeta rate limiting técnico).
- Testes obrigatórios de idempotência, cotas (soft/hard/concorrência), reconciliação e segurança (RLS com `app_user`).
- Não há gateway de pagamento, checkout, planos comerciais definitivos nem alteração de autenticação.

## Decisões comerciais ainda pendentes (fora de escopo desta ADR)

- Unidade de cobrança definitiva (consulta / validação / documento / fonte / relatório).
- Fonte indisponível é faturável? (recomendação: não; registro como decisão comercial).
- Revalidação do mesmo documento em 30 dias é nova cobrança?
- Tabela de preços e planos comerciais.
