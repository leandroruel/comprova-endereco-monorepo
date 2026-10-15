# PROGRESS.md

Estado: **Dashboard com auth + bulk search + stats por usuário** (2026-10-15)

## Dashboard (apps/dashboard)

- **Better Auth** — login/signup com email/senha, sessão de 7 dias, cookie httpOnly, trustedOrigins, strength meter, confirmar senha
- **Stats por usuário** — total de consultas, documentos únicos (DISTINCT doc_hmac), CNPJ/CPF, confirmadas/não sucedidas
- **Busca em lote** — drag & drop CSV, textarea, processamento em background, progresso em tempo real, export CSV/JSON
- **Sidebar** — navegação entre Valações e Busca em lote, nome do usuário, botão Sair
- **Hooks order fix** — todos os hooks antes dos early returns (crash após login)
- **VLM_ENABLED=false** — botões deep/auto escondidos da UI, API retorna 422 DEEP_PATH_DISABLED

## API (apps/api)

- **Better Auth** — Drizzle adapter, handler em /api/auth/*, sessionMiddleware extrai user do cookie
- **Rotas** — POST /v1/validations, GET /v1/validations/:id, GET /v1/stats, POST+GET+GET/:id+GET/:id/export /v1/batches, webhooks, subjects, contest
- **CORS** — origin: true, credentials: true (cookie cross-origin)
- **Auth API keys** — HMAC-SHA256 (sem argon2), prefix 12 chars, cache L1
- **Batch** — grava user_id, verdict, confidence, explanation em batch_item
- **Export** — CSV (posicao,tipo,documento,status,veredito,confianca,explicacao,erro) e JSON
- **Idempotência** — hash SHA-256 do request, 422 se divergir, replay com address
- **Session middleware** — lê cookie Better Auth, extrai user.id para request.sessionUser
- **Stats** — filtrado por user_id quando há sessão, COUNT DISTINCT doc_hmac para documentos únicos

## Revisão de código — 23 correções aplicadas

### Críticas (commit afd8d94)

1. Singleflight removido (ON CONFLICT resolve concorrência)
2. Policy 2026.12.1 corrigida (declarava 2026.11.1) + loader valida nome↔versão
3. deepEnrich idempotente (dedup sinais por checker_id@version)
4. Rate limiter — redis TIME, por tenant, HSET
5. API keys — HMAC-SHA256, prefix 12 chars, hash como cache key
6. Cotenancy v2.0.0 com unit_key (prédio vs sala)
7. SSRF — HTTPS only, redirect: manual, timingSafeEqual
8. Outbox — reentrance guard, poison pill → DLQ
9. Retenção — evidence S3+linha, outbox 7d, delivery 30d, batch_item hash
10. statement_timeout 10s em withTenant
11. exit(1) em shutdown com erro
12. insufficient_band lido do YAML
13. Advisory lock em migrações

### Altas (commit 467d18d)

14. Idempotência compara body (hash) + replay address
15. Batch — legal_basis, lease/timeout, error genérico
16. Canonicalização — DR/PROF/CEL/STA + 100A ≡ 100 A
17. Partições — DEFAULT + job mensal
18. timeoutMs real — Promise.race
19. address_signal_cache lido (SignalCacheReader)
20. Contest reason cifrada (AES-GCM)
21. CI — gitleaks + trivy, timeout 30min

### Fixes de produção (commits fab8e6a..30ae357)

22. Building key usa CEP (não municipioIbge) — chaves batem entre ingestor e fastpath
23. cep_not_found → unknown (não contradicts) — hard rule removida
24. Hooks order crash fix (tela branca após login)

## Dados (perfil zero-custo)

### Ingerido

- **Receita file 0**: 30M estabelecimentos, 20M building_keys distintos
- **CNEFE**: DF (1.3M) + SP (22.9M) + MG + outras UFs (28M total)
- **Municípios**: 5.572 códigos Receita
- **CEP via BrasilAPI**: ~200 CEPs (lento — 2.5/min, bulk source = CNEFE)

### Histórico de endereços (SCD Type 2 em tabela separada)

- `ref_estabelecimento_history` (migração 0018) — 32 partições hash
- Ingestão com UPSERT: detecta mudança de endereço → copia antigo para history → atualiza atual
- Detecta: logradouro, numero, complemento, bairro, cep, uf, situacao, nome_fantasia, cnae

### Known issues

- File 0 cobre CNPJs 00-98M; arquivos 1-9 ainda não ingeridos (mais ~30M CNPJs)
- CNEFE: SP completo, MG em progresso, outras UFs pendentes
- CEP backfill lento via BrasilAPI (2.5/min) — usar CNEFE como fonte bulk
- profiles:recompute precisa rodar após ingestão completa

## Infra-alvo (não provisionado — ADR-0001)

- `infra/terraform/` — network, EKS, Aurora, Redis, S3+KMS
- `infra/k8s/` — API deployment + HPA (150 rps/pod do k6) + PDB, worker spot
- `docs/capacidade.md` — estimativas de storage/queries

## Como rodar

```bash
pnpm install
pnpm db:migrate
pnpm db:seed         # cria API key dev
pnpm dev             # levanta tudo (API :3000, dashboard :5173, worker, ingestor)
pnpm test            # 109/109 testes
pnpm db:fence        # pgfence gate de migrações
```

## Fluxo de uso

1. Abre `http://localhost:5173`
2. Cria conta (email/senha) ou faz login
3. Valida um CNPJ individual ou cria um lote
4. Consulta stats no dashboard (filtrado por usuário)
5. Exporta resultados CSV/JSON

## Adiadas (precisam de $ ou dados)

- Chaves OpenAI + Google Street View → T2 VLM real
- Dump completo (10 arquivos da Receita + CNEFE de todas as UFs)
- Conta AWS (apply Terraform, DR, soak test)
- Multi-região (LGPD data residency)
