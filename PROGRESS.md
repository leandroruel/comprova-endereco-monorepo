# PROGRESS.md

Estado: **Dashboard com auth + bulk search + stats por usuário** (2026-10-15)

## Rotação segura de signing key (roadmap #24, etapa 24.2) (2026-10-21)

O modelo de estados já existia (`active = false` = superada, publicada para
verificar o passado; `revoked_at` = hard stop — ADR-0029). Faltava a **operação**:
a troca era feita à mão, sem atomicidade nem serialização. Agora
`rotateSigningKey` (`apps/api/src/services/signing-key-rotation.ts`) roda numa
transação que serializa rotações do mesmo tenant com
`pg_advisory_xact_lock`, marca a chave ativa atual como **superada** (só
`active`, nunca `revoked_at`) e publica/ativa a nova. O índice parcial único
`issuer_signing_key_active_uq` continua garantindo no máximo uma ativa; não há
`if (active)` na aplicação. Conflitos são explícitos: não sobrescrever material,
não reativar `key_id` superado, não reutilizar material de outra chave; repetir a
rotação para a chave já ativa é no-op.

Não houve migration (o schema já sustentava o lifecycle) nem endpoint novo: a
operação é administrativa (owner, como o provisionamento), exposta por
`pnpm db:rotate-key <tenant_id> <new_key_id>` — a nova chave precisa estar em
`CREDENTIAL_SIGNING_KEYS`. O `SigningKeyProvider` da etapa 24.1 não mudou: ele
continua recebendo a chave já selecionada por `loadActiveSigningKey`, então a
emissão nova usa B enquanto a VC antiga continua verificando com A. KMS/HSM e
rotação automática seguem fora de escopo.

Testes: novo `apps/api/src/services/signing-key-rotation.int.test.ts` (12 casos:
rotação, `superseded ≠ revoked`, idempotência, A→B→C, conflitos, rollback após
falha no meio, lock timeout, duas rotações concorrentes, isolamento entre tenants
e bootstrap). `apps/api/src/credential.int.test.ts` passou a rotacionar pela
operação real e verifica VC antiga (A) + VC nova (B), documentos públicos e
revogação posterior de A.

## Fronteira de assinatura: `SigningKeyProvider` (roadmap #24, etapa 24.1) (2026-10-21)

O domínio de emissão deixou de resolver o material privado e de derivar/validar a
chave pública. `issueCredential` agora depende de
`SigningKeyProvider.signerFor({ tenantId, keyId, publicKey })`, que devolve um
`Signer` para a chave **já selecionada** por `loadActiveSigningKey` (RLS +
`active`/`revoked_at`). A resolução do material, o guard de coerência
(`SIGNING_KEY_UNAVAILABLE`/`SIGNING_KEY_MISMATCH`) e o isolamento por
(`tenant_id`, `key_id`) ficam atrás do provider
(`apps/api/src/services/signing-key-provider.ts`).

A implementação atual (`makeConfiguredSigningKeyProvider`) continua lendo
`CREDENTIAL_SIGNING_KEYS`, com a mesma semântica (Ed25519, sem chave global de
reserva, sem fallback). Nenhum KMS/HSM foi integrado: a fronteira só torna
possível um `KmsSigningKeyProvider` futuro, sem tocar o domínio, o formato da VC,
o `proof`, o DID, o verificador ou o `credentialStatus`.

Testes: novo `apps/api/src/services/signing-key-provider.test.ts` (assinatura
verificável com a pública publicada; material ausente/incoerente; isolamento de
tenant; determinismo; configuração inválida no boot). Validação local:
`typecheck`, `lint` e `format` OK; `pnpm test` com 45 arquivos / 357 testes — as
20 suítes de integração exigem Docker/Podman e sua validação fica na CI.

## Escopo dedicado para administração de signing keys (2026-10-21)

A revogação de signing key deixou de exigir `validate:write` e passou a exigir
o novo scope `keys:write` (`apps/api/src/plugins/scope.ts`). Uma key usada para
validar/emitir credenciais não pode mais derrubar a chave de assinatura do
tenant; em contrapartida, uma key `keys:write` não ganha leitura, emissão ou
revogação de credencial.

O default de `api_key.scopes` continua `{validate:read,validate:write}`.
`keys:write` não é adicionado por autenticação, `bootstrap`, `load-tenant` nem
migration. Como não existe endpoint de administração de API keys, o grant é
operacional e explícito por `api_key_id`, com `UPDATE api_key` usando a
credencial administrativa do banco; o procedimento está no README e no
ADR-0030. Sem o grant, a rota retorna 403.

Testes ampliados em `apps/api/src/authz.int.test.ts`: `keys:write` revoga a
signing key do próprio tenant; `validate:write` e `validate:read` recebem 403
sem efeito colateral; key sem `keys:write` não revoga signing key de outro
tenant; key com `keys:write` de outro tenant recebe 404; key criada com o
default não ganha `keys:write`; e `keys:write` não autoriza escrita de
validation/credencial. `apps/api/src/credential.int.test.ts` foi ajustado para
usar `keys:write` nas keys que revogam signing keys. `pnpm test` passou com 64
arquivos / 555 testes.

## Snapshot de auditoria x autorização da credencial (2026-10-21)

`validation.issuer_scopes` continua guardando o snapshot **completo** dos
scopes da API key associado à validation (gravado na criação e imutável),
inclusive `keys:write`, para auditoria. O mapping para a credencial passou a
publicar em `assertionAuthority.scopes` somente os scopes de validação
(`validate:read`/`validate:write`), por allowlist em
`packages/credential/src/service/assertion.service.ts`. `keys:write` é uma
capacidade administrativa da API key (ator), não uma permissão do titular da
credencial, e não entra no documento assinado.

O campo foi renomeado de `comprova:authorization` para `assertionAuthority`:
o nome agora descreve a autoridade da asserção sem repetir o nome do produto, e
o termo é declarado explicitamente no `@context`. O verificador não interpreta
o campo como capacidade; a mudança elimina a ambiguidade e a exposição do
privilégio administrativo. Credenciais antigas com `keys:write` em
`comprova:authorization` continuam verificáveis (o schema aceita a forma legada
somente para leitura e nada é reescrito). Testes: unidade em
`packages/credential/src/service/credential.service.test.ts` (novo documento e
compatibilidade de leitura) e integração em
`apps/api/src/credential.int.test.ts` (key com os três scopes: snapshot no
banco, documento filtrado e verificação independente). `pnpm test` local: 44
arquivos / 351 testes; as 20 suítes de integração exigem Docker/Podman e sua
validação fica na CI. Typecheck, lint, format e `db:fence` também passaram.

## Enforcement de scopes das API keys (2026-10-21)

A autenticação já resolvia `request.tenant.scopes`, mas as rotas mutantes não
exigiam o scope correspondente. Foi adicionado um guard declarativo por rota
(`apps/api/src/plugins/scope.ts`), executado depois do `authenticate`:

- `requireReadScope` → `validate:read`;
- `requireWriteScope` → `validate:write`;
- API key válida sem o scope → `403 FORBIDDEN`; key ausente/inválida →
  `401 UNAUTHORIZED` (comportamento existente).

Mapa aplicado: leitura de validation/batches/stats/meta/webhooks/subjects exige
`validate:read`; criação/contestação de validation, emissão de credencial,
revogação de credencial, revogação de signing key, criação de batch, gestão de
webhooks e eliminação de subject exigem `validate:write`. Não foram criados
scopes novos; emissão/revogação de credencial e revogação de signing key usam
`validate:write` por ser o único scope de escrita do contrato. A checagem que
estava dentro do controller de signing keys foi movida para a rota.

O tenant isolation não foi alterado: uma key com o scope correto do tenant A
continua recebendo 404 para validation, credencial e signing key do tenant B; o
teste verifica que o status da credencial e o `revoked_at` da chave não mudam.
Decisão e tabela completa em
`docs/adr/0030-enforcement-de-scopes-das-api-keys.md`; README e
`docs/architecture.md` atualizados.

Testes: novo `apps/api/src/authz.int.test.ts` cobre leitura permitida, escrita
permitida, leitura negada para key só de escrita, todas as mutações negadas para
key só de leitura, 401 de key inválida e cross-tenant com scope correto.
`pnpm test` passou com 64 arquivos / 549 testes.

> Atualização (2026-10-21): a revogação de signing key foi separada para
> `keys:write`; o restante desta seção descreve o escopo do PR #32.

## Revisão de conformidade pós-PR #5 — W3C VC 2.0 (2026-10-20)

Implementação dos itens A1–A4, B1–B2 e C1–C2 da revisão do PR #5, em um commit
por item e com testes. A decisão consolidada está em
`docs/adr/0024-conformidade-w3c-identificadores-e-tempos.md`, seção **“Revisão
pós-PR #5”**.

- **A1 (`82af9d4`, revisão do PR #31)** — a checagem de origem é **fail-safe**:
  só `NODE_ENV=development|test` relaxa; `production`, `prod`, `staging` e
  `NODE_ENV` ausente recusam TLDs reservados (`.test`, `.example`, `.invalid`,
  `.localhost`, `.local`), `localhost` e IP literal. O `dev` da API declara
  `NODE_ENV=development` e `.env.example` o documenta, para `https://issuer.test`
  continuar aceito em desenvolvimento sem afrouxar produção.
- **A2 (`b919ade`)** — `verifyCredential` → `verifyCredentialIntegrity`, com
  `checked { integrity, time, status }` e `now?: Date`. Janela temporal
  `[validFrom, validUntil)`, `NOT_YET_VALID`/`EXPIRED`; status permanece
  `not_checked` (revogação é do `statusResolver`).
- **A3 (`27c5aa3`, ajuste `a3357b1`)** — replay do deep path compara policy e
  scorer; policy/scorer diferentes produzem novo `completed_at`. A comparação
  usa `last_evaluated_policy_hash`/`last_evaluated_scorer_version` (migração
  `0036`), separados do binding imutável da assertion, para que replay idêntico
  sob a policy nova preserve o instante e não revogue de novo.
- **A4 (`4bb729a`)** — VC 2.0 §4.9 permite `validFrom == validUntil`. O
  verificador aceita a igualdade; o emissor continua exigindo `<`.
- **B1 (`e8e7740`)** — `validUntil` é o menor entre
  `completed_at + policy.credential_ttl_seconds` e `observed_at + ttl_seconds`;
  `credential_ttl_seconds` é opcional (default 30 dias) e nenhuma policy
  publicada foi alterada. `expires_at` segue como retenção; janela
  vazia/invertida → `VALIDITY_WINDOW_INVALID`.
- **B2 (`24d1cd9`, revisão do PR #31)** — migração `0034_credential_issuance.sql`
  (RLS, append-only) guarda `issued_at` e o ponteiro de status por validation. A
  primeira emissão e o status `ACTIVE` são gravados na mesma transação; reemitir
  usa `proof.created = issued_at` e devolve JSON byte a byte igual (teste
  compara o documento inteiro e a unicidade das linhas). Trocar
  `CREDENTIAL_ISSUER_ORIGIN` muda o `credential_id` e bloqueia a reemissão de
  forma explícita (`409 CREDENTIAL_NOT_ISSUABLE`, detalhe
  `ISSUANCE_IDENTITY_CONFLICT`); teste de integração cobre emissão → troca de
  origem → reemissão.
- **C1 (`1146c68`)** — migração `0035_credential_status_reason.sql` adiciona
  `revocation_reason` (`manual`/`superseded`). Mudança de veredito, evidências,
  policy/scorer ou regressão a `partial` revoga a credencial já emitida como
  `superseded` na mesma transação; replay idêntico não revoga e reexecuções não
  reescrevem `revoked_at`.
- **C2 (`f1d043b`)** — teste ponta a ponta resolve o DID Document público,
  extrai a chave e verifica com `verifyCredentialIntegrity`, além de conferir
  `issuer` HTTPS, `alsoKnownAs`, `proof.verificationMethod` e o método DID
  (`<did>#<keyId>`, `controller = did`). Não houve divergência: `issuer` e
  `did:web` são URIs distintas ligadas por `alsoKnownAs`.
- **Documentação** — ADR-0024 ganhou a seção de revisão (incluindo riscos de
  vocabulário/domínio, correlação estável de CPF e SHA-256 vs HMAC do escopo do
  tenant); README e `.env.example` atualizados.
- **Revisão do PR #31** — guard de origem fail-safe (não só
  `NODE_ENV=production`); default de policy do worker alinhado ao da API
  (`2026.13.1`, evita revogação espúria de credenciais sob a policy correta);
  conflito de troca de origem vira `409 ISSUANCE_IDENTITY_CONFLICT` tipado; ADR
  corrigido (`validFrom <= validUntil`, ordem do `now` após a assinatura, tabela
  sem `comprova:expiresAt`); `revocation_reason` restrito a
  `manual|superseded` (`NOT VALID` na `0035` + `VALIDATE` na `0037`, em
  transações separadas para não manter o `ACCESS EXCLUSIVE` durante o scan);
  backfill unbatched da `0036` removido (o código já cai no binding imutável
  quando `last_evaluated_*` é NULL); a assertion é montada antes de persistir a
  primeira emissão/status `ACTIVE`, então uma validation legada sem bindings não
  deixa status de uma credencial nunca devolvida.
- **Validação** — `pnpm typecheck`, `pnpm lint`, `pnpm test` e `pnpm db:fence`
  executados. Nenhum teste de integração precisou ser pulado (Docker
  disponível). A suíte cobre as migrações `0034`/`0035`/`0036`.
- **Binding de emissão vs avaliação (A3)** — `validation.policy_hash`/
  `scorer_version` continuam imutáveis (0028) e são o que a credencial declara.
  O replay usa `last_evaluated_*` (0036), mutáveis. Uma credencial emitida
  depois de uma mudança de policy ainda declara o binding original; se o produto
  quiser que ela declare a policy nova, isso exige nova validation/assertion ou
  rebinding explícito (documentado no ADR-0024).

## Integridade relacional e retenção — correções da auditoria (2026-10-16)

Endurecimento de integridade/tenant-isolation/retenção **sem alterar a lógica de
negócio** (scoring, thresholds, verdicts, checkers, policy, `building_key`).

- **ALTO-1 — retenção do grafo de claim.** `validationRetentionTick` passa a remover
  `claim_evidence → claim` antes de `signal`/`validation_idempotency`/`validation`,
  eliminando órfãos. `subject` e `canonical_address` **não** são removidos (ciclo
  próprio).
- **ALTO-2 — retenção de `evidence` material.** Nova ordem robusta a crash/retry:
  (1) desvincula (`claim_evidence.evidence_id`, `signal.evidence_id`,
  `address_signal_cache.evidence_id` → NULL) → (2) remove o objeto do storage
  (idempotente) → (3) `DELETE FROM evidence`. Nunca o objeto físico é removido antes
  do banco.
- **MÉDIO-3 — unicidade `claim_evidence (claim_id, signal_id)`** (0024): "1 claim +
  1 signal = 1 claim_evidence"; pré-checagem explícita aborta em duplicatas históricas.
- **MÉDIO-5 — FK composta `claim (subject_id, tenant_id) → subject (subject_id,
tenant_id)`** (0025): garante `claim.tenant_id = subject.tenant_id` (antes, a FK
  simples permitia claim do tenant A apontar para subject do tenant B).
- **MÉDIO-4 — constraint trigger deferido** (0026): `claim_evidence.signal_id` deve
  pertencer à mesma validation do claim (FK impossível: `signal` é particionada).
  Deferido para o `COMMIT` porque o fast path insere `claim_evidence` antes de `signal`.
- **BAIXO-6 — remove `validation_idem_uq`** (0027): o índice incluía `created_at`
  (partição) e nunca deduplicava; a PK `validation_idempotency` é a barreira real.
- **BAIXO-7 — POST × GET × replay** devolvem o **mesmo** `address` (GET agora lê
  `canonical_address`).
- **BAIXO-8 — backfill legado**: o deep path só propaga `signal.evidence_id` para
  `claim_evidence.evidence_id` quando o id existe de fato em `evidence`.
- **BAIXO-9 — batch/retenção com conexão admin** documentado (RLS é por tenant; jobs
  são cross-tenant e a retenção apaga `evidence`, sem `DELETE` para `app_user`).
- **Testes** — +9 (retenção de claim/evidence, unicidade, tenant/subject,
  claim_evidence↔signal, consistência POST/GET/replay, concorrência, backfill legado).
  Suíte: **147/147**.
- **Integridade (dev)**: órfãos/duplicatas/cross-tenant = **0**; 87.741 signals sem
  `claim_evidence` são de validations **sem claim** (era pré-claim + benchmark), não
  violação atual.

## Revisão Claim → Claim Evidence — correções e desambiguação (2026-10-16)

- **Desambiguação `evidence` × `claim_evidence`** (migração `0023_claim_evidence_material.sql`): o PK de `claim_evidence` chamava-se `evidence_id`, colidindo com o artefato material `evidence`. Renomeado para `claim_evidence_id`; adicionado `claim_evidence.evidence_id` (FK **opcional** → `evidence`) e a FK `claim.address_id → canonical_address`. pgfence: `[SAFE]`.
- **`signal.evidence_id`** — semântica única: referencia **só** artefato material (`evidence`); o fast path (T0) grava **nulo** (antes gravava, por engano, o id de `claim_evidence`). O vínculo canônico `signal → claim_evidence` é `claim_evidence.signal_id`.
- **Fase 7 — paridade signal↔claim_evidence**: o deep path garante 1 `claim_evidence` por signal da validação, incluindo **backfill** das pré-existentes (validações legadas) e novos T1/T2 — idempotente (replay não duplica).
- **Fase 10 — claim sempre criado**: o fast path não deixa mais `validation` sem claim; a idempotência reusa o existente.
- **Fase 15 — GET expõe a nova semântica**: `GET /v1/validations/:id` e o replay idempotente passam a retornar `claim` e `evidence_summary` (antes só o POST).
- **Fase 16 — webhook/outbox**: o payload do evento de validação ganha `claim_id` e `claim_type` de forma aditiva (campos existentes preservados).
- **Fase 26 — building key**: documentação alinhada à fórmula canônica (`sha256(key_version | country_code | uf | cep | logradouro_norm | numero_norm)`, implementação única em `packages/core`).
- **Benchmark (FASE 23)** — fast path mantém o SLO (p95 < 120ms) no ponto de operação: **150 rps → p50 16ms / p95 ~23ms / p99 ~31ms, 100% checks**. Detalhes e ressalvas em `docs/load-report.md`.
- **Testes** — +4 (GET claim/summary, backfill legado, vínculo material opcional, payload de webhook) + asserções de replay. Suíte: **138/138**.

## Fase 11 + 14 — Diferencial OLD vs NEW e imutabilidade histórica (2026-10-16)

- **Fase 11 — teste diferencial ponta-a-ponta** (`apps/api/src/golden.int.test.ts`): para cada classe do dataset dourado, lê a validação persistida (caminho NEW, `evaluateClaim`) e **recomputa** o caminho OLD (`weightedScore` + `decide`) a partir dos `signal` brutos relidos do banco; compara veredito, score (`tanh`), confidence e explicação. Como o `signal` preserva `neutral`, qualquer colapso indevido de stance quebra o teste.
- **Fase 14 — imutabilidade** (`apps/worker/src/deep-enrich.int.test.ts`): snapshot de `claim_evidence` prova que o enriquecimento é **append-only** (T1 anexa sem tocar as linhas do fast path), que **replay não muta nem duplica** e que não há `evidence_id` duplicado.
- **Testes** — +1 (golden) e +1 (deep-enrich). Suíte: 134/134.

## Fase 10 — `evaluateClaim` (scoring explícito) (2026-10-16)

- **`evaluateClaim({ claim, evidence, policy, now })`** em `packages/core/src/assessment.ts` — fronteira única de scoring; reconstrói signals e delega para `weightedScore` + `decide`. Retorna `{ score, decision }`.
- **Fidelidade de stance** — a evidência em memória espelha o stance fiel do signal (inclui `neutral`); colapsa `neutral → unknown` só na persistência. Preserva a confidence do `decide` (ex.: `SHARED_VIRTUAL`), garantindo no-op semântico.
- **Fast path e deep path** — passam a usar `evaluateClaim` (deep path avalia o claim já resolvido, dentro da transação).
- **Testes** — novo `packages/core/src/evaluate.test.ts` (5 casos OLD vs NEW, inclui `neutral != unknown`, hard rule `FOREIGN` e evidência vazia). Suíte: 132/132.
- **Nota** — `weightedScore`/`decide` continuam existindo como primitivas internas (deep path usa a versão intermediária como gate T1).

## Fase 13 — Explicação estruturada (2026-10-16)

- **`AssessmentExplanation`** — `buildAssessmentExplanation(decision, evidence)` no core (`packages/core/src/assessment.ts`): `code` (veredito), `message`, ids de evidências que sustentam/contradizem.
- **Persistência** — forma estruturada gravada no mesmo jsonb `validation.explanation` (`summary`, `code`, `supporting_evidence`, `contradicting_evidence`).
- **DTO** — campo aditivo `explanation_detail` (opcional); `explanation` (string) preservado; OpenAPI/contracts, SDK e dashboard atualizados.
- **Deep path** — inalterado (sem `claim_evidence`): grava `{ summary }` e devolve `explanation_detail: null`.
- **Testes** — 3 unit (core) + 4 integração (`claim.int.test.ts`, inclui round-trip POST↔GET). Suíte: 126/126.

## Deep path — trilha claim/evidence (2026-10-16)

- **`deepEnrich`** agora reusa o claim do fast path (ou cria, se ausente) e grava `claim_evidence` por sinal T1/T2, ligando `signal_id`.
- **Idempotência** — dedup por `checker@version`; replay não duplica evidências.
- **`explanation_detail`** — deep path preenche igual ao fast path (reconstruído de todas as evidências do claim).
- **Nota** — `signal.evidence_id` referencia apenas artefato material (S3/VLM); a ligação observação↔claim é `claim_evidence.signal_id` (desambiguado na migração 0023).
- **Testes** — `f3.int.test.ts` +1 (reuso de claim + ligação de evidências T1) e asserções no caso ambíguo. Suíte: 127/127.

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
pnpm test            # local sem Docker: 44 arquivos / 351 testes; integração na CI
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
