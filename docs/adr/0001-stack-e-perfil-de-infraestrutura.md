# ADR-0001: Stack e perfil de infraestrutura (zero-custo)

## Status

Aceito (2026-10-10). Emendas: 0006 (acesso a dados via Drizzle + convenções FP) substitui o
trecho "SQL puro nos caminhos quentes".

## Contexto

Projeto sideproject sem finalidade comercial e **sem cartão de crédito**. O desenho original
(spec) assume AWS (EKS, Aurora, ElastiCache, S3) como alvo, mas provisionar AWS é inviável agora.
O produto exige validação investigativa de endereço com fast path de baixa latência, deep path
assíncrono e trilha de auditoria. Precisamos de stack que rode 100% local sem custo e que mantenha
a porta aberta para a nuvem via ports/adapters.

## Decisão

- **Linguagem/runtime:** TypeScript strict (`strict`, `noUncheckedIndexedAccess`), Node.js 22,
  ESM puro, sem `any` em código de produção.
- **Monorepo:** pnpm workspaces + Turborepo (tasks: `typecheck`, `dev`).
- **API HTTP:** Fastify 5 + Zod 4 com `@fastify/type-provider-zod@1.0`
  (`validatorCompiler`/`serializerCompiler` do provider + `jsonSchemaTransform` para OpenAPI 3.1).
  Erros em RFC 9457 (`application/problem+json`).
- **Banco:** PostgreSQL 16 + PostGIS/pg_trgm/pgcrypto via `postgis/postgis:16-3.4`. Cliente
  `postgres` (postgres.js) com prepared statements nos caminhos quentes. **Migrações são SQL
  versionado escrito à mão** com runner próprio (`packages/db/src/runner.ts`); Drizzle ORM entra
  na Fase 1 apenas como camada de modelagem para queries comuns — não gera migrações (partições,
  índices parciais e RLS não são cobertos pelo drizzle-kit).
- **Cache:** Valkey 8 (compatível com Redis) local.
- **Objetos/evidências:** **Zenko CloudServer** (S3 API, Apache 2.0) em container, com porta
  `ObjectStore` S3-compatible para troca futura por R2/S3 só com configuração.
- **Deep path:** Temporal **self-hosted** (`temporal server start-dev` em container) — Fase 2.
- **Infra de produção (EKS, Aurora, Karpenter, KEDA, Terraform):** documentada como
  arquitetura-alvo em `docs/architecture.md`, **não provisionada**. SLOs (3k rps, p95 < 120 ms)
  são alvo declarado; k6 valida localmente na proporção da máquina.

## Alternativas rejeitadas

- **AWS desde o início:** requer cartão; mesmo free tier exige método de pagamento. Rejeitado até
  haver patrocínio/decisão de comercializar.
- **Cloudflare R2 p/ evidências:** a ativação da R2 exige método de pagamento na conta Cloudflare
  mesmo dentro do free tier. Reavaliar quando houver; a porta `ObjectStore` torna a troca trivial.
- **MinIO local:** `minio/minio` foi removido do Docker Hub/quay (imagens públicas encerradas em
  2025); `bitnami/minio` sem `latest`. Zenko CloudServer atende com imagem pública estável.
- **zod 3:** o `@fastify/type-provider-zod@1.0` exige zod >= 4.2.
- **Go/Java:** contraria a spec e o ecossistema escolhido (stack TS unificada).

## Consequências

- Iteração rápida e custo zero; limitações de SLO local ficam registradas como risco.
- Dependência de imagem `zenko/cloudserver` com config de `restEndpoints` montada
  (`compose/cloudserver-config.json`) — hostnames `localhost` e `objectstorage` mapeados.
- CI (GitHub Actions) roda lint/format/typecheck/test com Testcontainers (Docker disponível no
  runner `ubuntu-latest`).
