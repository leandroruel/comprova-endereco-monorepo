# Ambiente e credenciais

Referência de configuração local, intake de evidências e assinatura de
credenciais verificáveis. O [`.env.example`](../.env.example) é a lista
executável de variáveis; este documento explica os pontos que costumam pegar.

## Arquivo `.env` e API keys

Tudo vem do `.env` na raiz — `.env.example` documenta as variáveis e o
`.gitignore` protege o arquivo. Dois pontos que costumam pegar:

- **`VITE_API_KEY`** é a chave que o dashboard manda no `Authorization: Bearer`.
  O `envDir` do Vite aponta para a raiz, então é o mesmo arquivo que os scripts
  do backend leem (`tsx --env-file=.env`); só o que começa com `VITE_` chega ao
  browser. Sem a chave a API responde 401 e o dashboard loga o motivo no
  console. Uma chave nova sai de `pnpm db:seed` (tenant de dev) ou de
  `pnpm --filter @comprova/ingestor start -- load-tenant` (tenant de carga).
- **`API_KEY_PEPPER`** é o segredo do HMAC das chaves (a linha guarda só o
  HMAC, nunca a chave). Trocar o pepper **invalida todas as chaves emitidas** —
  o `pnpm db:seed` só cria outra se o tenant de dev não tiver nenhuma ativa.
  Para revogar uma chave, `UPDATE api_key SET revoked_at = now() WHERE ...`; a
  API confere a revogação no banco, mas guarda o resultado por 60s em memória
  (cache por prefixo), então o 401 pode demorar até um minuto.

Os scopes das API keys (`validate:read`, `validate:write`, `keys:write`) e a
concessão administrativa de `keys:write` estão no
[ADR-0030](adr/0030-enforcement-de-scopes-das-api-keys.md).

## Intake e análise de evidências

- **`S3_*` / `EVIDENCE_MAX_BYTES` / `EVIDENCE_MAX_CONCURRENCY`** configuram o
  intake de comprovante (F1.1). O endpoint usa o mesmo bucket privado do worker
  via `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET`
  (`S3_REGION` opcional, default `us-east-1`) e grava em
  `tenants/<tenant>/evidence/<artifact-id>`. Se o conjunto S3 não estiver
  completo, a API sobe, mas o upload falha fechado com
  `503 EVIDENCE_STORAGE_UNAVAILABLE`; não há fallback para memória. O limite
  default é **50 MiB** (o mesmo de `evidence_artifact`) e `EVIDENCE_MAX_BYTES`
  só pode reduzi-lo. Como o arquivo é bufferizado antes do storage, um semáforo
  por processo limita uploads em voo com `EVIDENCE_MAX_CONCURRENCY` (default
  **4**, máximo **16**); o limite é por processo, então cada réplica tem o seu.
- **`EVIDENCE_ANALYSIS_MAX_BYTES`** limita os bytes que o worker carrega para a
  análise F1.2 (default 50 MiB). A análise consome `evidence_analysis` com o
  pool de manutenção e roda com PDF textual; imagem retorna `unsupported` até
  existir OCR. Sem `DATABASE_ADMIN_URL` o loop não sobe e o worker registra um
  aviso.

## Credenciais verificáveis

As regras abaixo valem para emissão, verificação, revogação e rotação. Cada
bloco aponta o ADR correspondente; o README só resume o caminho.

### Origem do issuer

**`CREDENTIAL_ISSUER_ORIGIN`** é a origem HTTPS **controlada pelo projeto** que
serve de base para o `issuer` e para o `credentialSubject.id` das credenciais
verificáveis (ADR-0024). Não há default e a biblioteca não conhece domínio
nenhum: o valor é validado no boot (HTTPS, sem path/query/fragmento) e, enquanto
não houver um domínio de produção confirmado, use uma origem reservada
(`https://issuer.test`). O `tenant_id` interno **não** aparece na URL — o path do
issuer leva um digest do tenant. A validação da origem é **fail-safe**: só é
relaxada com `NODE_ENV=development` ou `NODE_ENV=test`; com `NODE_ENV` ausente,
`prod`, `staging` ou `production` o boot recusa TLDs reservados (`.test`,
`.example`, `.invalid`, `.localhost`, `.local`), `localhost` e IP literal. Como o
`issuer.id` (e o `credential_id`) derivam da origem, **trocar
`CREDENTIAL_ISSUER_ORIGIN` impede reemitir validations já emitidas** — a API
responde `409 CREDENTIAL_NOT_ISSUABLE` com detalhe
`ISSUANCE_IDENTITY_CONFLICT`; a origem definitiva deve ser escolhida antes de
emitir em produção.

### Chaves de assinatura por tenant

**`CREDENTIAL_SIGNING_KEYS`** assina a credencial **por tenant** (ADR-0026). É um
JSON — lista de `{"tenant_id", "key_id", "private_key_pem"}` — lido no boot: JSON
inválido, PEM inválida ou chave não-Ed25519 **derrubam a API** (falha fechado).
Cada tenant assina com a sua própria chave; um tenant sem entrada na configuração
(ou sem chave registrada em `issuer_signing_key`) **não** emite (`409
CREDENTIAL_NOT_ISSUABLE`, detalhe `SIGNING_KEY_UNAVAILABLE`) — não existe chave
global de reserva. O `key_id` é o fragmento publicado em
`proof.verificationMethod` (`<issuer.id>#<keyId>`) e pode se repetir entre
tenants (o namespace é o issuer). Só o material **público** sai da API
(`GET /issuers/:scope` e a porta de descoberta
`GET /.well-known/comprova-issuer/:scope`, em `publicKeyMultibase`); a privada
nunca é persistida, logada nem devolvida. A chave pública publicada tem de
**corresponder** ao material configurado, senão a emissão falha com
`SIGNING_KEY_MISMATCH`. O domínio de emissão não resolve a privada diretamente:
ele fala com um `SigningKeyProvider`
(`apps/api/src/services/signing-key-provider.ts`) e recebe um assinador para a
chave **já selecionada** (tenant + `key_id` + pública publicada). O backend
default (`SIGNING_KEY_PROVIDER=local`) lê `CREDENTIAL_SIGNING_KEYS`; com
`SIGNING_KEY_PROVIDER=aws-kms` o KMS assina sem entregar a privada (ADR-0032),
sem mudar o domínio. No backend local o material privado vive em
configuração/segredo externo; no KMS ele nunca sai do KMS. Uma chave com
`revoked_at` (ADR-0029) sai dos documentos públicos e deixa de ser aceita; o
`active = false` continua sendo apenas rotação.

### Validade, reemissão e credenciais superadas

- **Validade da credencial** (ADR-0024, revisão pós-PR #5): `validFrom` é o
  `completed_at` real e `validUntil` é
  `min(completed_at + policy.credential_ttl_seconds, observed_at + ttl_seconds)`.
  `credential_ttl_seconds` é opcional na policy (default **30 dias**) e não
  altera policies já publicadas; o TTL de cada evidência limita a credencial. A
  janela vazia/invertida falha com `VALIDITY_WINDOW_INVALID`. `expires_at`
  continua sendo o horizonte de **retenção**, não o `validUntil`.
- **Reemissão determinística** (ADR-0024, B2): a primeira emissão por validation
  é registrada em `credential_issuance` (`issued_at` + `credential_id` público,
  sem o documento assinado). Reemitir reassina com `proof.created = issued_at` e
  devolve bytes idênticos enquanto issuer/chave/policy não mudarem; o status
  `ACTIVE`/`REVOKED` continua em uma única linha e não é reativado.
- **Credenciais superadas** (ADR-0024, C1): quando o deep path muda veredito,
  evidências, policy ou scorer, ou regride a validation concluída para
  `partial`, a credencial já emitida é revogada como `superseded` na mesma
  transação. Replay idêntico não revoga, inclusive sob uma policy nova (a
  comparação usa a última policy avaliada, não o binding imutável da assertion);
  a coluna de motivo não é pública.

### Verificação, status e DID

- **Verificação** (ADR-0024, A2): `verifyCredentialIntegrity` (antigo
  `verifyCredential`) devolve `checked` com integridade, tempo e status. Aceita
  `now` e usa `[validFrom, validUntil)`; sem `now`, declara que o tempo não foi
  checado. Revogação **não** é consultada aqui — use o `statusResolver`.
- **Status/revogação** (ADR-0027): a credencial carrega `id` e
  `credentialStatus.id` assinados, mas o valor (`ACTIVE`/`REVOKED`) fica em uma
  linha por `credential_id` (tabela `credential_status`, isolada por RLS). O
  `POST /v1/credentials/:credentialId/revoke` é autenticado e monotônico; o
  `GET /issuers/:scope/credentials/:credentialId/status` é público e devolve só
  `{ "status": "ACTIVE" | "REVOKED" }`. O verificador independente precisa de um
  `statusResolver`; sem status resolvido ele falha fechado
  (`STATUS_UNAVAILABLE`), e `REVOKED` resulta em `STATUS_REVOKED`.
- **DID/DID Document** (ADR-0028): o issuer tem um DID determinístico
  `did:web:<host>:issuers:<escopo>`, derivado do `issuer.id` (sem `tenant_id`,
  subject, documento ou `validation_id`). O DID Document é público em
  `GET /issuers/:scope/did.json` e publica a mesma chave do issuer em
  `verificationMethod`/`assertionMethod` (`Multikey`/`publicKeyMultibase`), com
  `alsoKnownAs` ligando o DID à URL HTTPS que a credencial já carrega em
  `issuer`. O verificador resolve essa chave por `makeHttpDidResolver`, sem
  banco, chave privada nem API interna. O `issuer` e o
  `proof.verificationMethod` da credencial **não mudaram**.

### Revogação, rotação e AWS KMS

- **Revogação/expiração de chave** (ADR-0029): `issuer_signing_key.revoked_at`
  é o hard stop, separado de `active`. Um instante passado revoga (inclusive
  credenciais já emitidas); um instante futuro agenda a expiração. A chave
  revogada/vencida não aparece em `GET /issuers/:scope` nem no DID Document, e
  o verificador falha fechado (`VERIFICATION_METHOD_UNRESOLVED`). O
  `POST /v1/signing-keys/:keyId/revoke` é autenticado, escopado por tenant,
  exige `keys:write`, é idempotente e só permite encolher a confiança;
  `?effective_at=<ISO-8601>` agenda a expiração, e uma chamada sem o parâmetro
  antecipa a revogação (nunca a adia). Não há reativação: uma chave apenas
  rotacionada (`active = false`) continua publicada.
- **Rotação de chave** (ADR-0031): `rotateSigningKey`
  (`apps/api/src/services/signing-key-rotation.ts`) troca a chave ativa numa
  transação atômica, serializada por tenant com `pg_advisory_xact_lock`. A chave
  anterior vira **superada** (`active = false`, sem tocar `revoked_at`) e segue
  publicada para verificar as credenciais antigas; a nova passa a assinar. O
  índice parcial único garante no máximo uma ativa mesmo sob duas rotações
  concorrentes. Não sobrescreve material publicado, não reativa `key_id`
  superado e não reutiliza material de outra chave; repetir para a chave já ativa
  é no-op. Operação administrativa via
  `pnpm db:rotate-key <tenant_id> <new_key_id>` (a nova chave precisa já estar em
  `CREDENTIAL_SIGNING_KEYS`). Não há endpoint HTTP de rotação nesta etapa.
- **Backend AWS KMS** (ADR-0032): `SIGNING_KEY_PROVIDER=aws-kms` faz o KMS
  assinar a chave já selecionada com `ECC_NIST_EDWARDS25519`/`ED25519_SHA_512` +
  `MessageType: RAW` (Pure EdDSA, compatível com `eddsa-jcs-2022`); a privada
  nunca chega à aplicação. A referência canônica (ARN) fica em
  `issuer_signing_key.kms_key_reference` (NULL = material local, o default). A
  pública continua no banco e a verificação pública **não** consulta a AWS.
  Provisionamento/rotação explícitos por
  `pnpm db:provision-kms-key <tenant_id> <key_id> <kms_key_reference>` e
  `pnpm db:rotate-kms-key <tenant_id> <new_key_id> <kms_key_reference>`; não há
  migração automática das chaves locais nem endpoint HTTP novo.

## Outras variáveis

`DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, `OPENAI_API_KEY`, `GOOGLE_STREET_VIEW_KEY`, `VLM_ENABLED`,
`TEMPORAL_*`, `PORT`, `DB_POOL_MAX`, `LOG_LEVEL` e `POLICY_VERSION` estão
documentadas no [`.env.example`](../.env.example). O `.env` não deve ser
commitado.

## Logs (Elastic Stack)

`ELASTIC_PASSWORD`, `KIBANA_PASSWORD`, `KIBANA_ENCRYPTION_KEY`,
`KIBANA_BIND_ADDRESS`, `KIBANA_PORT` e os limites de memória do Elastic Stack
são opcionais e só são usados pelo perfil `elk`. O `pnpm compose:up` padrão não
depende deles. Para subir, consultar e parar os serviços, veja
[Logs centralizados](logs-elk.md).
