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

| Conceito                          | `event_type`          | `billable` | Justificativa                                           |
| --------------------------------- | --------------------- | ---------- | ------------------------------------------------------- |
| Evento técnico (checker)          | `technical_execution` | false      | Passo intermediário, não unidade comercial              |
| Tentativa de processamento        | `processing_attempt`  | false      | Execução técnica (deep enqueue), não resultado entregue |
| Evento de uso (conclusão)         | `usage_event`         | true       | Unidade comercial consumida (validação concluída)       |
| Replay/idempotência (mesma chave) | `usage_event`         | false      | Mesma operação lógica, não duplica consumo              |
| Fonte externa indisponível        | `usage_event`         | false      | Indisponibilidade não é valor entregue                  |

**Unidade faturável**: exatamente uma por `tenantId + validationId`, apenas quando a validação atinge status `completed` com resultado faturável. Eventos técnicos e tentativas são registrados separadamente (para auditoria e rastreio) mas nunca duplicam a unidade comercial. Reprocessamentos e retries com a mesma chave de idempotência retornam o evento previamente registrado (`replayed: true`) sem consumir cota novamente (ADR-0044 § Ordem de idempotência e cota).

Recomendação inicial (decisão comercial ainda pendente): indisponibilidade de fonte externa, retry e replay **não** geram nova cobrança. A unidade de cobrança provisória é "validação concluída" (1 unidade por `validation` concluída com resultado faturável).

O campo `billable` + `source` tornam a decisão auditável.

### 4. Cotas por tenant

A coluna `tenant.monthly_quota` (bigint) já existe no schema (`packages/db/src/schemas/tenancy.ts`) mas não é utilizada comercialmente.

- **Cota hard**: quando o consumo acumulado no período >= `monthly_quota`, novas operações faturáveis são impedidas (403/429).
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

Limitações:

- Não considera eventos de períodos diferentes da validação (apenas janela `completed_at` × `occurred_at` no período informado).
- Não corrige dados automaticamente; cabe ao operador avaliar as divergências reportadas.

### 7. Endpoints

- `GET /v1/usage/consumption` — consumo por período (unidades, faturáveis, custo, distribuição).
- `GET /v1/usage/quota` — situação da cota (limite, consumido, restante, soft/hard).
- `GET /v1/usage/events` — histórico de eventos de uso.

Autenticação: tenant resolvido pelo contexto autenticado (sessão ou M2M), scopes explícitos (`validate:read`). Nunca confiar em `tenantId` livre do cliente.

### 8. RLS e segurança

Novas tabelas (`usage_event_idempotency`, `tenant_quota_audit`) com `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, políticas `USING`/`WITH CHECK` com `app_tenant_id()`, grants para `app_user`. Testar com role `app_user`.

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
