# ADR-0005: PII, pseudonimização e isolamento multi-tenant (RLS)

## Status

Aceito (2026-10-10)

## Contexto

LGPD: CPF/CNPJ de pessoa física, nomes e endereços de PF não podem aparecer em claro em logs,
traces nem tabelas de validação. O sistema é multi-tenant e um tenant jamais pode ler dado de
outro — inclusive por query malformada ou falha na aplicação.

## Decisão

### Pseudonimização

- Documentos são guardados apenas como `doc_hmac` (HMAC-SHA256 com **chave por tenant**). Em dev a
  chave vem de `API_KEY_PEPPER` (.env); em produção, KMS (quando houver). `doc_enc` (envelope
  encryption) fica opcional e só se o tenant exigir devolução do dado.
- `subject` tem unique `(tenant_id, doc_type, doc_hmac)`.
- Tabelas compartilhadas entre tenants (`canonical_address`, `address_profile`, `evidence`)
  contêm só chaves/coordenadas — sem nome/endereço em texto.

### Redação central (defesa em profundidade)

- `packages/observability/src/redact.ts`: redige por padrão de dígitos (CPF/CNPJ, com e sem
  máscara) e por denylist de chaves (`nome`, `logradouro`, `address`, `email`, `telefone`, ...).
- Todo logging da aplicação passa por `createLogger`, que aplica `redactDeep` antes do pino.
  Testes de unidade quebram o build se CPF/nome vazar em output de log.
- Rosto/placa (Fase 3) serão tratados como dado sensível: não persistir recortes.

### RLS (Row-Level Security)

- App conecta com role **`app_user`** (criada na migração 0002, senha via `APP_DB_PASSWORD`);
  migrações rodam com superuser. `FORCE ROW LEVEL SECURITY` em `subject`, `validation`,
  `validation_idempotency`, `usage_event`, `webhook_endpoint`, `webhook_delivery`, `audit_log`.
- Política padrão: `tenant_id = app_tenant_id()` com `app_tenant_id()` = `current_setting('app.tenant_id')`
  (NULL quando não setado → nenhuma linha visível). O acesso tenant-scoped usa
  `withTenant(sql, tenantId, fn)` que faz `set_config('app.tenant_id', ..., true)` em transação.
- `audit_log`: aceita inserção de sistema (tenant NULL) e visibilidade de eventos de sistema para
  todos; **append-only garantido por GRANTS** (sem UPDATE/DELETE para `app_user`) — testado.
- Exceções documentadas: `tenant`, `api_key`, `legal_basis`, tabelas de referência e de endereço
  compartilhadas ficam **sem RLS** (não contêm PII de PF; `api_key` precisa de lookup pré-tenant
  durante autenticação e guarda só hash+prefixo).

### Autenticação

- API keys guardadas como **argon2id** de `pepper + key`; lookup por prefixo de 8 caracteres com
  índice único parcial (apenas chaves ativas). Última coluna mutável (`last_used_at`) tem GRANT
  UPDATE restrito à coluna.

## Consequências

- Isolamento enforced no banco, não só na aplicação; teste de integração cobre: insert sem
  contexto falha, insert cross-tenant falha, leitura cross-tenant vazia, update/delete de
  audit_log falha.
- Chaves de HMAC por tenant exigem gestão de chave no KMS quando subir para produção.
