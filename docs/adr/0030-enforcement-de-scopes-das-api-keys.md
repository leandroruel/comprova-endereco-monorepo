# ADR-0030: Enforcement de scopes das API keys

## Status

Aceito (2026-10-21). Fecha a lacuna de autorização entre a autenticação por API
key e as rotas mutantes de `/v1`. Não introduz RBAC, roles, OAuth/OIDC nem
scopes novos.

## Contexto

A autenticação já resolve a API key para `request.tenant`, incluindo
`tenantId`, `apiKeyId` e `scopes` (`apps/api/src/plugins/auth.ts`). O banco
define apenas dois scopes, no default de `api_key.scopes`
(`0002_tenancy.sql`):

- `validate:read`
- `validate:write`

Antes deste ADR, as rotas de leitura e a maioria das rotas mutantes não
consultavam `scopes`. A única exceção era a revogação de signing key, que fazia
a checagem dentro do controller. Na prática, uma API key válida com
`validate:read` conseguia criar validation, emitir credencial, revogar
credencial e criar/remover webhooks.

O controle que faltava é de **autorização da operação**, distinto do
isolamento por tenant:

```text
API key
   │
   ▼
authenticate  ──► 401 se ausente/inválida/revogada
   │
   ▼
tenant + scopes
   │
   ▼
requireScope("validate:read" | "validate:write")  ──► 403 se faltar
   │
   ▼
route handler
   │
   ▼
RLS / withTenant  ──► 404 se o recurso for de outro tenant
```

## Decisão

### 1. Um guard pequeno e declarado por rota

`apps/api/src/plugins/scope.ts` exporta `requireScope(scope)` e os dois
preHandlers reutilizáveis `requireReadScope` / `requireWriteScope`. Cada rota
protegida declara o scope no próprio `preHandler`, depois do `authenticate` do
encapsulamento `/v1`:

```ts
app.post('/validations', { preHandler: requireWriteScope, schema }, handler)
```

Não há checagem de scope espalhada em controllers. O guard:

- retorna **401 `UNAUTHORIZED`** se `request.tenant` não existir (rota montada
  fora do `authenticate` ou autenticação que falhou);
- retorna **403 `FORBIDDEN`** (`"Insufficient scope"`, problem+json) se o
  tenant não tiver o scope.

A decisão de 403 acontece antes do handler e **não consulta o recurso**. Um
`credential_id` ou `key_id` de outro tenant não transforma o 403 em um oráculo
de existência.

### 2. Mapa das operações existentes

Como o contrato só define dois scopes, toda leitura protegida usa
`validate:read` e toda mutação protegida usa `validate:write`:

| Scope            | Operações                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validate:read`  | `GET /v1/validations/:id`, `GET /v1/batches`, `GET /v1/batches/:id`, `GET /v1/batches/:id/export`, `GET /v1/stats`, `GET /v1/meta`, `GET /v1/webhooks`, `GET /v1/subjects/:id/validations`                                                                                           |
| `validate:write` | `POST /v1/validations`, `POST /v1/validations/:id/contest`, `POST /v1/validations/:id/credential`, `POST /v1/credentials/:credentialId/revoke`, `POST /v1/signing-keys/:keyId/revoke`, `POST /v1/batches`, `POST /v1/webhooks`, `DELETE /v1/webhooks/:id`, `DELETE /v1/subjects/:id` |

Não foi criado `credential:write`, `webhook:write`, `batch:write` nem
`admin:*`. Emissão de credencial e revogação de credencial/signing key exigem
`validate:write` porque é o único scope de escrita existente no contrato. Se o
produto quiser separar essas capacidades, isso é uma decisão explícita de
contrato (novo scope, migração de dados e atualização das keys emitidas), não
um efeito colateral deste enforcement.

As rotas públicas de issuer (`GET /issuers/:scope`, `did.json`, status da
credencial e `/.well-known/comprova-issuer/:scope`) continuam fora de `/v1`,
sem API key e sem scope. Rotas de auth, health e metrics também permanecem
públicas.

### 3. Scope não substitui isolamento por tenant

O scope autoriza a **operação**, não o **recurso**. As consultas e mutações
continuam dentro de `withTenant`/RLS e escopadas por `tenant_id`. Uma key do
tenant A com `validate:write` tentando revogar credencial ou signing key do
tenant B recebe **404**, inclusive quando o recurso existe. O teste de
regressão verifica que o status da credencial e o `revoked_at` da chave de B
permanecem inalterados.

### 4. 401 vs 403

- **401 `UNAUTHORIZED`** — API key ausente, inválida, revogada ou prefixo sem
  correspondência. É o comportamento que já existia.
- **403 `FORBIDDEN`** — API key válida e dentro do tenant, mas sem o scope
  exigido pela rota. O `detail` é genérico (`Insufficient scope`) e não diz
  qual recurso ou scope falta.

## Consequências

- Uma key `validate:read` não consegue mais executar nenhuma mutação de
  `/v1`; uma key `validate:write` continua conseguindo as mutações de
  validation e as operações administrativas que o contrato atual agrupa nesse
  scope.
- A configuração de scopes das fixtures de teste continua centralizada em
  `packages/testing/src/fixtures.ts` (default: os dois scopes). Os testes de
  autorização usam keys explícitas `validate:read`, `validate:write` e
  inválida.
- O guard é declarativo por rota. Uma rota nova em `/v1` que não declare
  `preHandler` continua autenticada, mas não ganha autorização por scope
  automaticamente; a revisão de rota precisa escolher o scope.
- Não há migração: a coluna `api_key.scopes` e o default já existiam.

## Alternativas descartadas

- **Checar `tenant.scopes.includes(...)` em cada controller**: repetitivo,
  fácil de esquecer e mistura autorização com regra de negócio.
- **Mapear scope por método HTTP em um hook global**: menos explícito e
  perigoso para rotas futuras que não sejam um CRUD uniforme.
- **Criar scopes específicos por recurso**: correto apenas com uma decisão de
  contrato e migração das keys existentes; fora do escopo desta correção.
