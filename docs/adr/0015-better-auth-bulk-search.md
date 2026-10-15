# ADR-0015: Better Auth + bulk search + stats por usuário

## Status

Aceito (2026-10-15)

## Contexto

O dashboard precisa de autenticação (era dev-only sem auth), busca em lote para múltiplos
documentos, e métricas por usuário. O stack já tem Fastify + Drizzle + PostgreSQL.

## Decisão

### Better Auth

- `better-auth@1.7.10` com Drizzle adapter (pg), email/password, sessão de 7 dias
- Tabelas: `user`, `session`, `account`, `verification` (migração 0019/0020) — nomes exigidos
  pelo better-auth, sem prefixo (fighting the adapter custou mais que ceder)
- `trustedOrigins: ['http://localhost:5173', 'http://localhost:3000']` (cross-origin)
- `secret` de `BETTER_AUTH_SECRET` no `.env` (32+ chars, `openssl rand -base64 32`)
- Fastify route: `/api/auth/*` com `auth.handler(Request)` (não `toNodeHandler` — é void)
- Dashboard: `createAuthClient` de `better-auth/react`, cookies `credentials: 'include'`

### Sessão middleware (API)

- `makeSessionMiddleware(auth)` — preHandler que lê o cookie, chama `auth.api.getSession()`
  e anexa `request.sessionUser = { id, email, name }`
- Silencioso em erro (sessão é opcional — rotas /v1 funcionam com Bearer token OU cookie)

### Stats por usuário

- `validation.user_id` (migração 0020) — FK para `user.id`
- `POST /v1/validations` grava `request.sessionUser?.id`
- `GET /v1/stats` filtra por `user_id` quando há sessão
- `unique_documents` = `COUNT(DISTINCT subject.doc_hmac)` — não `COUNT(*)`

### Bulk search

- `POST /v1/batches` — aceita até 1000 documentos, valida com `isValidDocument`
- Dashboard lê CSV client-side (FileReader → parse CNPJs → POST JSON) — sem multipart
- Batch processor grava `verdict`, `confidence`, `explanation` em `batch_item` após cada item
- Export: CSV (posicao,tipo,documento,status,veredito,confianca,explicacao,erro) e JSON

### Fluxo de auth no dashboard

1. App boot → `useEffect` chama `authClient.getSession()`
2. Sem sessão → `<LoginPage />` (email/senha, confirmar senha, strength meter)
3. Login OK → `setSession(data)` → dashboard renderiza
4. Todas as chamadas da API usam `credentials: 'include'` (envia cookie)
5. API extrai user_id do cookie via sessionMiddleware

### Hooks order (crash após login)

- Todos os hooks (useState, useQuery, useMutation) devem vir **antes** de qualquer early return
- `getSession` inicial usa `useEffect`, não render-time (causava double-call)
- Se o número de hooks muda entre renders → React crash (tela branca)

## Alternativas rejeitadas

- **Clerk**: SaaS, requer cartão, free tier 10k MAU
- **Lucia**: mais setup manual, menos ecossistema
- **toNodeHandler**: retorna void, não Response — incompatível com Fastify handler pattern
- **Tabelas com prefixo auth_**: better-auth Drizzle adapter exige nomes exatos (user, session, account, verification)

## Consequências

- Login funciona em ~30 min de setup
- Stats isolados por usuário (multi-user no futuro)
- Bulk search reusa o batch processor existente
- Export CSV/JSON sem dependência externa (formatação server-side)
