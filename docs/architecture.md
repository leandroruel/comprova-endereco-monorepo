# Architecture — comprova-endereco

> Address Intelligence API: validação investigativa de endereço a partir de CNPJ/CPF com
> veredito explicável, score de confiança e trilha de auditoria.

## Visão geral

```
                         ┌────────────────────────────┐
 Cliente ──HTTPS──► Dashboard (React+Vite :5173)      │
                         │ Better Auth (login/sessão) │
                         └────────────┬───────────────┘
                                      │ fetch (credentials: include)
                                      ▼
                         ┌────────────────────────────┐
                         │ apps/api (Fastify :3000)   │
                         │ stateless, N pods          │
                         └────────────┬───────────────┘
                                      │ fast path: Postgres + Redis
                                      │ batch: background processor
                                      │ deep path: Temporal → Worker
                                      ▼
                              Postgres 16 + PostGIS
                              (32 partições hash, RLS multi-tenant)
                                      │
                              Outbox → EventBus → Webhooks
```

## Fast path vs deep path

| Modo   | Checkers                                                                                                          | Latência   | Disponível       |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| `fast` | T0: document_integrity, registry_status, country_check, cep_consistency, cnefe_match, cotenancy, cnae_vs_location | ~15ms      | sempre           |
| `auto` | T0 → se ambíguo → T1 (geocode, Places, footprint)                                                                 | assíncrono | VLM_ENABLED=true |
| `deep` | T0 → T1 → T2 (Street View + VLM)                                                                                  | 5-15s      | VLM_ENABLED=true |

Com `VLM_ENABLED=false` (default), apenas `fast` funciona — deep/auto retornam `422 DEEP_PATH_DISABLED`.

## Building key (identidade de endereço)

Fórmula **canônica** — implementação única em `packages/core/src/address.ts`
(`addressKeys`):

```text
building_key = sha256(key_version | country_code | uf | cep | logradouro_norm | numero_norm)
```

onde `key_version = "1"` e os campos são unidos por `|` (`numero_norm` é o número
normalizado). A **mesma** função é usada pelo **ingestor** e pelo **fast path** —
não existe uma segunda implementação (SQL ou outra) do algoritmo. Análises de
cardinalidade devem reproduzir exatamente este payload (não uma versão SQL
simplificada).

A fórmula usa **CEP** (não `municipioIbge`) porque:

- O ingestor não tem `municipioIbge` (vem da Receita como código próprio)
- O fast path preenche `municipioIbge` via CEP backfill
- Com `municipioIbge` na chave, ingestor e fast path gerariam hashes diferentes

## Histórico de endereços (SCD Type 2)

| Tabela                        | Papel                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `ref_receita_estabelecimento` | Estado atual (1 linha por CNPJ, otimizada para hot path) |
| `ref_estabelecimento_history` | Histórico de mudanças (PK: cnpj + valid_from)            |

O ingestor com UPSERT detecta mudanças (logradouro, número, CEP, situação, CNAE) e:

1. Copia a linha antiga para history com `valid_from` / `valid_to`
2. Atualiza a tabela principal

## Multi-tenancy e Auth

| Camada    | Mecanismo                                                                    |
| --------- | ---------------------------------------------------------------------------- |
| Dashboard | Better Auth (cookie de sessão, email/password)                               |
| API /v1   | Bearer token (API key HMAC-SHA256) + sessionMiddleware lê cookie Better Auth |
| Banco     | RLS FORCE: `SET app.tenant_id` em toda transação via `withTenant()`          |

Depois da autenticação, as rotas `/v1` exigem o scope da operação no
`preHandler` (`validate:read` para leitura, `validate:write` para mutações de
validation/credencial e `keys:write` para administração de signing keys). A API
key sem scope recebe 403; o isolamento por tenant continua no RLS e devolve 404
para recursos de outro tenant. `keys:write` é opt-in e não é adicionado
automaticamente às keys existentes ou ao default. Mapa e decisão em
[ADR-0030](adr/0030-enforcement-de-scopes-das-api-keys.md).

## Stats por usuário

O middleware de sessão Better Auth extrai `user.id` do cookie e anexa a `request.sessionUser`.
Cada validação grava `user_id`. O endpoint `/v1/stats` filtra por user_id:

- `total` = COUNT(*) (todas as queries)
- `unique_documents` = COUNT(DISTINCT subject.doc_hmac) (documentos únicos)
- `by_doc_type` = COUNT DISTINCT por CNPJ/CPF

## Bulk search

1. Dashboard lê CSV client-side → parse documentos → POST /v1/batches (JSON)
2. API cria batch + items, responde 202
3. Batch processor processa itens em background (5/tick, lease 60s)
4. Dashboard poll GET /v1/batches/:id a cada 3s
5. Export: GET /v1/batches/:id/export?format=csv|json

## Isolamento, integridade e retenção

- **RLS FORCE por tenant** em `subject`, `validation`, `validation_idempotency`,
  `usage_event`, `webhook_*`, `audit_log`, `batch`, `batch_item`, `claim`,
  `claim_evidence`, `evidence_artifact`. O runtime sempre acessa via `withTenant`
  (`SET LOCAL app.tenant_id`).
- **Integridade relacional** (migrações 0024–0027): unicidade
  `claim_evidence (claim_id, signal_id)`; FK composta
  `claim (subject_id, tenant_id) → subject (subject_id, tenant_id)`; constraint
  trigger deferido garantindo `claim_evidence.signal_id` da mesma validation; remoção
  do índice de idempotência enganoso `validation_idem_uq`. Detalhes em ADR-0016.
- **`evidence` é global** (sem `tenant_id`/RLS): o vínculo tenant-scoped é
  `claim_evidence` (RLS FORCE) e `claim_evidence.evidence_id` é ponteiro opcional.
  **`signal`** é derivado da validation (sem `tenant_id`/RLS); a coerência tenant é
  garantida pela cadeia `signal.validation_id → validation.tenant_id` + trigger 0026.
  **`evidence_artifact`** (F0.1/ADR-0035) é o artefato físico tenant-scoped para
  documentos de cliente: FK composta `(claim_evidence_id, tenant_id)`, RLS FORCE,
  sem `UPDATE`, `storage_key` no namespace do tenant e nenhum binário no Postgres.
- **Retenção** (matriz de TTL em ADR-0016): `validation` expira por `expires_at` e
  remove o grafo `evidence_artifact → claim_evidence → claim → signal →
validation_idempotency`; o objeto do artefato é apagado **antes** da linha e a
  auditoria registra `artifacts_removed`. `evidence` expira por `retention_until`
  com **desvinculação antes** da remoção do objeto físico.
  `subject`/`canonical_address` têm ciclo próprio e **não** são removidos pela
  retenção.

### Por que o batch e a retenção usam conexão admin

`batchTick` (`apps/api/src/services/batch-processor.ts`) e os ticks de retenção
(`apps/worker`) rodam com `DATABASE_ADMIN_URL`, não com `app_user`:

- o batch processa itens de **múltiplos** tenants em um único tick (a RLS é por
  tenant e não há tenant "atual"): ele adquire leases com `FOR UPDATE SKIP LOCKED`
  sobre `batch_item` (RLS FORCE) e finaliza batches de vários tenants;
- a retenção precisa apagar `evidence` (o `app_user` não tem `DELETE`) e varrer
  validações expiradas de todos os tenants.

Superfície/risco: são jobs internos de background, sem entrada de usuário direta,
executados em processo próprio, e o `runFastPath` do batch grava `tenant_id`
explicitamente (o contexto `withTenant` continua sendo aplicado). **Não** concedemos
`DELETE` global ao `app_user` nem ampliamos privilégios do runtime. Um papel dedicado
de worker (entre `app_user` e admin) é possível no futuro, mas exigiria migração de
grants — não é necessário hoje.

## Evidências: artefato, observação, avaliação e credencial

A cadeia de responsabilidades é:

```text
Artifact      material bruto (PDF/imagem) em object storage privado
   ↓
Evidence      observação lógica ligada a um claim (claim_evidence + descritor)
   ↓
Assessment    avaliação/score/veredito explicável
   ↓
Credential    saída verificável e assinada
```

`artifact` **não** é `credential`: o primeiro é matéria-prima (PII, retenção
curta, nunca público); a segunda é o resultado assinado da avaliação. Misturar os
dois faria a credencial carregar o documento original ou o artefato virar prova
de um veredito que ele não sustenta.

Hoje a **única** fonte que materializa artefato em `evidence` é o street
view/VLM no deep path (`apps/worker/src/modules/evidence/evidence.service.ts`);
o fast path grava `claim_evidence` com `evidence_id = NULL`. **Não existe**
endpoint de upload, OCR/PDF, nem consulta a fonte fiscal.

A fundação para documento de cliente é `evidence_artifact` (F0.1/ADR-0035):

```text
validation → claim → claim_evidence → assessment → credential
                     ├── evidence (legado; street view, global)
                     └── evidence_artifact (PII; tenant-scoped, write-once)
```

`evidence_artifact` guarda somente metadados + `storage_key`
(`tenants/<tenant>/evidence/<artifact>`), com RLS FORCE, FK composta
`(claim_evidence_id, tenant_id)`, `sha256`/tamanho/content-type validados e
`retention_until`. O binário fica no `ObjectStore` existente; nenhuma URL pública
é persistida. O endpoint de upload, o sniffing de conteúdo e o OCR são F1.

O alvo (documento do cliente + NF3e/NFAg-e), o contrato de verificação, a
taxonomia de resultado e as extensões mínimas estão em
[`arquitetura-evidencias.md`](arquitetura-evidencias.md). As decisões estão nos
[ADR-0033](adr/0033-verificacao-de-evidencias-por-adaptadores.md) (contrato),
[ADR-0034](adr/0034-consulta-a-fontes-fiscais-endpoints-oficiais.md) (consulta a
endpoints oficiais) e [ADR-0035](adr/0035-artefato-de-evidencia-tenant-scoped.md)
(artefato tenant-scoped). A ordem de execução está no [`roadmap.md`](roadmap.md).

Dois pontos de atenção já visíveis:

- **`evidence` continua global e sem RLS** — adequado para fachada pública;
  inadequado para comprovante com PII, que agora tem tabela própria.
- **`weightedScore` é aditivo e não deduplica fonte** — duas evidências do mesmo
  fato podem somar como independentes; a correção é decisão de scoring
  (`SCORER_VERSION`), não de schema.

## Políticas de scoring

| Versão    | Mudanças                                                             |
| --------- | -------------------------------------------------------------------- |
| 2026.10.1 | Base: 7 checkers T0, 3 hard rules                                    |
| 2026.11.1 | + Pesos T1 (geocode, places, footprint)                              |
| 2026.12.1 | + Peso T2 (street_view_vlm)                                          |
| 2026.13.1 | - Hard rule cep-inexistente (era falso positivo); fix versão interna |

Simulador: `pnpm --filter @comprova/ingestor start -- policy:simulate <versao> [--report]`

Hoje existe **uma policy global** carregada no boot; `validation.policy_version`
registra qual versão foi usada. Não há seleção de policy por cliente/caso — é
uma decisão de produto em aberto no [`roadmap.md`](roadmap.md).

## Componentes

| Camada                                                          | Onde                  | Fase |
| --------------------------------------------------------------- | --------------------- | ---- |
| Dashboard (React+Vite, Better Auth, TanStack Query)             | `apps/dashboard`      | 6+   |
| API HTTP (Fastify, auth, rate limit, batch, export)             | `apps/api`            | 0-6  |
| Worker Temporal (deep path T1/T2)                               | `apps/worker`         | 2-3  |
| Ingestor (Receita, CNEFE, CEP, profiles, simulador)             | `apps/ingestor`       | 1+   |
| Domínio puro (FP: Signal, Checker, scoring, address keys)       | `packages/core`       | 0+   |
| DB (migrações SQL, Drizzle, adapters, RLS)                      | `packages/db`         | 0+   |
| Checkers T0/T1/T2                                               | `packages/checkers`   | 1-3  |
| Providers (Nominatim, Overpass, Street View, VLM, BrasilAPI)    | `packages/providers`  | 2-3  |
| SDK TypeScript                                                  | `packages/sdk`        | 6    |
| Credencial verificável (VC 2.0 + Data Integrity eddsa-jcs-2022) | `packages/credential` | 7    |

## Capacidade (medido em dev)

| Métrica                    | Valor        |
| -------------------------- | ------------ |
| Fast path p95 @ 100 rps    | 21ms         |
| Fast path p95 @ 150 rps    | 29ms         |
| Saturação (1 processo)     | ~280 rps     |
| Argon2 teto (sem cache)    | ~30 rps      |
| Argon2 teto (com cache L1) | ~280 rps     |
| Pool DB ótima              | 50 conexões  |
| 3k rps (alvo prod)         | ~20 réplicas |

## Alvo de produção (documentado, não provisionado — ADR-0001)

- EKS multi-AZ + Karpenter + KEDA
- Aurora PostgreSQL 16 multi-AZ + réplica leitura
- ElastiCache/Valkey cluster
- S3/R2 com SSE-KMS + lifecycle
- Deploy canário/blue-green via GitOps (Argo CD)
