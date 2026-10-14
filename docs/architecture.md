# Arquitetura — comprova-endereco

> Address Intelligence API: validação investigativa de endereço a partir de CNPJ/CPF, com
> veredito explicável, score de confiança e trilha de auditoria.

## Visão geral

```
                         ┌────────────────────────────┐
 Cliente ──HTTPS──► apps/api (Fastify, stateless)
                         └────────────┬───────────────┘
                                      │ fast path: Postgres(+réplica) + Valkey/Redis (cache L2) + LRU L1
                                      │ deep path: start workflow
                                      ▼
                              Temporal (self-hosted dev / Cloud ou HA em prod)
                                      │
                         ┌────────────┴─────────────┐
                         ▼                          ▼
                   apps/worker (Activities)    apps/ingestor (jobs/CLI)
                   - checkers T1/T2            - dump Receita (mensal)
                   - provedores externos       - CNEFE, CEP
                   - VLM / imagens             - recomputo address_profile
                         │
        ┌────────────────┼──────────────────────┐
        ▼                ▼                      ▼
   Postgres+PostGIS    Valkey (cache)     Object Storage S3-compatible
   (primário + réplicas, RLS por tenant)   (evidências; CloudServer em dev, R2/S3 em prod)
        │
   Outbox ► EventBus (porta) ► webhooks / analytics / billing
```

## Fast path vs deep path

- **Fast path** (T0) nunca chama rede externa: responde com Postgres (Receita, CNEFE, CEP,
  `address_profile`, `address_signal_cache`) + caches. Se faltar evidência, devolve
  `status: "partial"` e dispara o deep path (se `mode: "auto"`).
- **Deep path** (T1/T2) roda em workflows Temporal por tiers, com curto-circuito entre
  avaliações, e só executa T2 (VLM/imagens) se o score seguir ambíguo.

## Camadas (Fase 0 implementada; Fases 1+ indicadas)

| Camada                                                                                        | Onde                                                  | Fase |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---- |
| API HTTP (Fastify, auth API key argon2id, rate limit token-bucket, problem+json, OpenAPI 3.1) | `apps/api`                                            | 0    |
| Contratos Zod + problems RFC 9457                                                             | `packages/contracts`                                  | 0    |
| Domínio puro (tipos `Signal`, `Checker`, `Stance`, validação CPF/CNPJ)                        | `packages/core`                                       | 0    |
| DB: migrações SQL versionadas, runner, RLS + `withTenant`                                     | `packages/db`                                         | 0    |
| Observabilidade: logger com redação PII, métricas Prometheus                                  | `packages/observability`                              | 0    |
| Testes: Testcontainers (Postgres+PostGIS, Valkey), fixtures                                   | `packages/testing`                                    | 0    |
| Canonicalização BR, `building_key`, ingestores, checkers T0, scoring                          | `packages/core`, `packages/checkers`, `apps/ingestor` | 1    |
| Workflows Temporal, providers geocode/places, webhooks, batch                                 | `apps/worker`, `packages/providers`                   | 2    |
| Street View + VLM (OpenAI), evidências com retenção                                           | `packages/providers`, `packages/checkers`             | 3    |
| `partner_graph`, simulador de políticas, shadow mode                                          | `packages/core`                                       | 4    |
| Fluxo CPF consentido, direitos do titular, LGPD docs                                          | `apps/api`, `docs/lgpd`                               | 5    |

## Alvo de produção (documentado, não provisionado — ver ADR-0001)

- EKS multi-AZ + Karpenter (spot para T2) + KEDA (profundidade de task queue), HPA por RPS na API.
- Aurora/RDS Postgres 16 multi-AZ + réplicas (fast path lê réplica), PgBouncer/RDS Proxy.
- ElastiCache/Valkey cluster; S3/R2 com SSE e lifecycle; ALB + WAF; GitOps (Argo CD).
- SLOs declarados: fast p95 < 120 ms; deep p95 < 15 s; 3k rps fast path. Validação real por k6
  local (Fase 6 com infra real, se houver).
- Multi-região active-passive com atenção à residência de dados (LGPD) — decisão futura.

## Estimativa de capacidade

Ver docs/capacidade.md (medicoes do k6 F6 + estimativas com dump). Antiga secao:

- `ref_receita_estabelecimento`: ~60M linhas × ~250 B ≈ 15 GB + índices (~2–3×) → working set
  por `building_key`/`cep` cabe em RAM de uma máquina dev (32–64 GB) para testes.
- `ref_cnefe_address`: ~50M linhas com Point → ~20 GB.
- `validation`/`signal`: ~1–5 KB por validação → partições mensais de centenas de MB a poucos GB.
