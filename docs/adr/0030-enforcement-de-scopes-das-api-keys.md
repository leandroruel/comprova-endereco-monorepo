# ADR-0030: Enforcement de scopes das API keys

## Status

Aceito (2026-10-21; atualizado em 2026-10-21 para separar a administração de
signing keys em `keys:write`). Fecha a lacuna de autorização entre a
autenticação por API key e as rotas mutantes de `/v1`. Não introduz RBAC,
roles, OAuth/OIDC nem um sistema genérico de permissões.

## Contexto

A autenticação já resolve a API key para `request.tenant`, incluindo
`tenantId`, `apiKeyId` e `scopes` (`apps/api/src/plugins/auth.ts`). O default de
`api_key.scopes` (`0002_tenancy.sql`) define dois scopes:

- `validate:read`
- `validate:write`

A revogação de signing key era a única rota que consultava `scopes`, dentro do
controller. Antes deste ADR, as demais rotas de leitura e a maioria das rotas
mutantes não consultavam o scope: uma key válida com `validate:read` conseguia
criar validation, emitir credencial, revogar credencial e criar/remover
webhooks.

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
requireScope("validate:read" | "validate:write" | "keys:write")  ──► 403 se faltar
   │
   ▼
route handler
   │
   ▼
RLS / withTenant  ──► 404 se o recurso for de outro tenant
```

## Decisão

### 1. Um guard pequeno e declarado por rota

`apps/api/src/plugins/scope.ts` exporta `requireScope(scope)` e os preHandlers
reutilizáveis `requireReadScope`, `requireWriteScope` e
`requireKeysWriteScope`. Cada rota protegida declara o scope no próprio
`preHandler`, depois do `authenticate` do encapsulamento `/v1`:

```ts
app.post('/validations', { preHandler: requireWriteScope, schema }, handler)
app.post('/signing-keys/:keyId/revoke', { preHandler: requireKeysWriteScope, schema }, handler)
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

Leitura protegida usa `validate:read`; mutações de validation, credencial,
batch, webhook e subject usam `validate:write`; administração de signing key usa
`keys:write`:

| Scope            | Operações                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate:read`  | `GET /v1/validations/:id`, `GET /v1/batches`, `GET /v1/batches/:id`, `GET /v1/batches/:id/export`, `GET /v1/stats`, `GET /v1/meta`, `GET /v1/webhooks`, `GET /v1/subjects/:id/validations`                                                    |
| `validate:write` | `POST /v1/validations`, `POST /v1/validations/:id/contest`, `POST /v1/validations/:id/credential`, `POST /v1/credentials/:credentialId/revoke`, `POST /v1/batches`, `POST /v1/webhooks`, `DELETE /v1/webhooks/:id`, `DELETE /v1/subjects/:id` |
| `keys:write`     | `POST /v1/signing-keys/:keyId/revoke`                                                                                                                                                                                                         |

Não foi criado `credential:write`, `webhook:write`, `batch:write` nem
`admin:*`. Emissão e revogação de credencial continuam exigindo
`validate:write`. A administração da signing key foi separada porque uma key
usada para validar/emitir credenciais não deve conseguir derrubar a chave de
assinatura do tenant.

As rotas públicas de issuer (`GET /issuers/:scope`, `did.json`, status da
credencial e `/.well-known/comprova-issuer/:scope`) continuam fora de `/v1`,
sem API key e sem scope. Rotas de auth, health e metrics também permanecem
públicas.

### 3. API keys existentes e concessão de `keys:write`

O default de `api_key.scopes` continua sendo
`{validate:read,validate:write}`. `keys:write` é **opt-in** e não é concedido
automaticamente por:

- autenticação ou leitura de `api_key.scopes`;
- `pnpm db:seed` / `bootstrap`;
- `load-tenant` do ingestor;
- migration de dados;
- criação de uma nova API key com o default.

Uma API key antiga que só tem `validate:write` continua com exatamente os
mesmos scopes e recebe **403** ao tentar revogar uma signing key. Nenhum
privilégio administrativo é inferido em tempo de autenticação.

Não existe, hoje, endpoint ou fluxo de autoatendimento para administrar API
keys na aplicação. A concessão de `keys:write` é uma operação administrativa
manual, usando a credencial de administração do banco:

```sql
UPDATE api_key
SET scopes = array_append(scopes, 'keys:write')
WHERE api_key_id = '<uuid-da-key>'
  AND NOT ('keys:write' = ANY (scopes));
```

O `UPDATE` é explícito por `api_key_id`, idempotente e não altera outras keys.
Ele exige acesso administrativo ao banco e deve ser auditado. Keys novas criadas
por `bootstrap`/`load-tenant` também nascem sem `keys:write`; se precisarem
revogar signing keys, recebem o scope pelo mesmo procedimento.

Essa limitação é deliberada: criar um endpoint de administração de API keys,
um CLI de grant ou um bootstrap que promova keys existentes seria uma decisão
de produto separada, com seu próprio modelo de autorização e auditoria.

### 4. Scope não substitui isolamento por tenant

O scope autoriza a **operação**, não o **recurso**. As consultas e mutações
continuam dentro de `withTenant`/RLS e escopadas por `tenant_id`. Uma key do
tenant A com `keys:write` tentando revogar signing key do tenant B recebe
**404**, inclusive quando o recurso existe. O teste de regressão verifica que o
`revoked_at` da chave de B permanece inalterado.

### 5. 401 vs 403

- **401 `UNAUTHORIZED`** — API key ausente, inválida, revogada ou prefixo sem
  correspondência. É o comportamento que já existia.
- **403 `FORBIDDEN`** — API key válida e dentro do tenant, mas sem o scope
  exigido pela rota. O `detail` é genérico (`Insufficient scope`) e não diz
  qual recurso ou scope falta.

## Consequências

- Uma key `validate:read` não consegue mais executar nenhuma mutação de `/v1`.
- Uma key `validate:write` continua conseguindo as mutações de validation,
  credencial, batch, webhook e subject, mas **não** revoga signing key.
- Uma key `keys:write` revoga signing key do próprio tenant e não ganha, por
  isso, permissão de leitura, emissão ou revogação de credencial.
- O default de `api_key.scopes` permanece com dois scopes. `keys:write` só
  existe em keys que receberam o grant explícito.
- A configuração de scopes das fixtures de teste continua centralizada em
  `packages/testing/src/fixtures.ts` (default: os dois scopes). Os testes de
  autorização usam keys explícitas `validate:read`, `validate:write`,
  `keys:write` e inválida.
- O guard é declarativo por rota. Uma rota nova em `/v1` que não declare
  `preHandler` continua autenticada, mas não ganha autorização por scope
  automaticamente; a revisão de rota precisa escolher o scope.
- Não há migração: `api_key.scopes` é `text[]` e já aceita o novo valor. O
  grant é um `UPDATE` operacional, não uma alteração de schema.
- `validation.issuer_scopes` continua sendo o snapshot **completo** de todos os
  scopes da API key no momento da emissão (ADR-0017), inclusive `keys:write`,
  para auditoria. A credencial publica em `assertionAuthority.scopes` somente
  os scopes de validação (`validate:read`/`validate:write`). `keys:write` é uma
  capacidade administrativa da API key (ator), não uma permissão do titular
  nem uma declaração da credencial, e por isso não entra no documento assinado.
  O termo é publicado sem o prefixo do produto e declarado no `@context`; o IRI
  continua no namespace do vocabulário.
- Credenciais antigas com `keys:write` em `comprova:authorization` continuam
  verificáveis: o schema aceita essa forma legada somente para leitura e o
  verificador não a interpreta como capacidade. A filtragem e o novo nome
  valem para novas emissões, sem migração ou reescrita de documentos
  existentes.

## Alternativas descartadas

- **Checar `tenant.scopes.includes(...)` em cada controller**: repetitivo,
  fácil de esquecer e mistura autorização com regra de negócio.
- **Mapear scope por método HTTP em um hook global**: menos explícito e
  perigoso para rotas futuras que não sejam um CRUD uniforme.
- **Manter a revogação de signing key em `validate:write`**: acopla uma
  capacidade administrativa à key usada para emitir credenciais.
- **Adicionar `keys:write` ao default ou promovê-lo em migration**: concede
  privilégio administrativo implicitamente a keys existentes/novas.
- **Criar `credential:write`/`webhook:write`/`batch:write` agora**: correto
  apenas com uma decisão de contrato e migração das keys existentes; fora do
  escopo desta correção.
