# PROGRESS.md

Estado: **Extração física do QR (F2.2b) + normalização da referência fiscal (F2.2a) + contrato fiscal e materialização (F2.1) + verificação do documento enviado (F1.3) + intake/análise do comprovante (F1.1/F1.2) + guarda de fetch externo (F0.2) + artefato tenant-scoped (F0.1) + credencial com KMS + roadmap canônico** (2026-10-24)

## Extração física do QR a partir do artefato (F2.2b — parte física) (2026-10-24)

A parte física da F2.2b liga o **artefato real** (o comprovante já guardado em
`evidence_artifact`) ao `FiscalReference`/`FiscalLookupInput` da F2.2a. Ela
decodifica o QR localmente e **não consulta** SEFAZ/autorizador: a resolução
server-side do endpoint, a allowlist preenchida e o parsing da resposta
continuam pendentes na segunda metade da F2.2b. O pedido original chamava esta
etapa de "F2.2a"; no roadmap canônico a F2.2a é a normalização.

- `extractFiscalReferenceFromArtifact` em
  `packages/providers/src/fiscal/reference.ts` aceita
  `{ data: Uint8Array, contentType }` e cobre PNG, JPEG e PDF. O payload
  decodificado passa pelo mesmo `extractFiscalReference` da F2.2a, então não há
  normalizador paralelo.
- Decoder `zxing-wasm@3.1.6` (`reader`), com o WASM carregado do pacote local
  via `createRequire(...).resolve('zxing-wasm/reader/zxing_reader.wasm')` e
  `prepareZXingModule({ overrides: { wasmBinary } })`. **Sem CDN e sem fetch**;
  um teste com `fetch` instrumentado comprova. `image-size@2.0.4` faz a
  pré-checagem de dimensões (sem decodificar a imagem).
- Limites: 16 MP e borda de 10.000 px por imagem, 8 símbolos QR, 50 páginas e
  64 imagens por PDF. O decoder lê `maxSymbols + 1` apenas para detectar
  truncamento; exatamente `maxSymbols` referências legíveis ainda passam pela
  política de múltiplos QR (não viram `QR_TOO_MANY_SYMBOLS`). Estouro vira
  `inconclusive` (`IMAGE_TOO_LARGE`, `PDF_TOO_MANY_PAGES`,
  `PDF_TOO_MANY_IMAGES`, `QR_TOO_MANY_SYMBOLS`), nunca `found` incompleto.
- PDF usa `unpdf.extractImages` + `getDocumentProxy({ maxImageSize })` e só lê
  **raster embutido**. QR vetorial/desenhado não é renderizado: retorna
  `inconclusive`/`PDF_QR_VECTOR_UNSUPPORTED`, tanto quando não há raster quanto
  quando o raster inspecionado não contém QR (não é possível afirmar ausência
  absoluta). Nenhuma dependência nativa/canvas foi adicionada; o limite de
  páginas é validado antes de qualquer decodificação de QR ou extração de texto.
- Política determinística para múltiplos QR
  (`extractFiscalReferenceFromPayloads`): payloads duplicados/mesmo fingerprint
  → `found`; referências fiscais distintas → `unsupported`/`AMBIGUOUS_REFERENCE`
  (nunca escolhe o primeiro QR); QR fiscal único + QR não fiscal → `found` com
  `MULTIPLE_QR_CODES`. QR ilegível detectado (`returnErrors`) →
  `inconclusive`/`QR_NOT_READABLE`.
- `FiscalReference` ganhou `status = inconclusive` e os reason codes físicos
  (`QR_*`, `IMAGE_*`, `PDF_*`, `UNSUPPORTED_ARTIFACT_TYPE`, `MULTIPLE_QR_CODES`);
  `FISCAL_REFERENCE_CONTRACT_VERSION` subiu para `2`.
- Integração no `DocumentAnalyzer`: `DocumentAnalysisResult` ganhou
  `fiscalReference` (`DOCUMENT_ANALYSIS_CONTRACT_VERSION = '3'`,
  `text_document@1.2.0`). A referência é anexada a PDFs (inclusive sem camada
  textual) e a imagens (que continuam `unsupported` quanto a OCR, mas já trazem
  o QR). `redactFiscalReference` remove a URL **antes** de persistir; o schema
  do resultado exige `url = null` e valida os enums/reason codes.
- Sem tabela/migration nova (`evidence_analysis.result` é JSONB), sem consulta
  fiscal, sem alteração de scoring, `FiscalVerificationResult` ou allowlist.
  Um teste de integração sobe um PDF com QR, roda o tick, confirma que a
  referência persistida não contém a URL e que `toFiscalLookupInput` usa
  tenant/claim/artefato do **contexto confiável**.
- Dependências novas: `zxing-wasm@3.1.6` (MIT; `@types/emscripten`, `type-fest`)
  e `image-size@2.0.4` (MIT; sem dependências). Ambas diretas em
  `@comprova/providers`.
- Limitações deliberadas: QR vetorial em PDF fica para uma etapa futura (se
  houver canvas com limite de tempo/memória); artefatos antigos só ganham a
  nova análise em replay/backfill (nova versão do analyzer); não há timeout
  cooperativo no decoder WASM — o risco é limitado pelos tetos de pixels e
  símbolos. O hardening futuro deve isolar o decoder (worker/limite de tempo)
  antes de aumentar esses tetos; isso permanece no backlog operacional, não
  neste PR.
- Correções da revisão: o estado do decoder agora é resetado quando a
  inicialização do WASM falha, então a chamada seguinte tenta de novo em vez de
  ficar presa em `QR_DECODER_UNAVAILABLE` (regressão em
  `reference-artifact.retry.test.ts`); `maxSymbols` ganhou piso 2, pois
  `maxSymbols = 1` rejeitava um único QR como `QR_TOO_MANY_SYMBOLS`. O decoder
  agora lê `maxSymbols + 1` e conta apenas referências legíveis: exatamente
  `maxSymbols` QRs ainda passam pela política (dois iguais → `found`, dois
  distintos → `AMBIGUOUS_REFERENCE`), com testes específicos em
  `maxSymbols = 2`. PDF com raster inspecionado sem QR passou de `not_found`
  para `inconclusive`/`PDF_QR_VECTOR_UNSUPPORTED`; o limite de páginas é
  validado antes de decodificar QR/texto (teste com `unpdf` mockado). O
  fingerprint não recalculável após a redaction ganhou teste explícito. Os
  testes de URL maliciosa passaram a usar QR real (a matriz loopback/localhost/
  metadata/RFC1918 fica em `reference-artifact.network.test.ts`, com `fetch`
  envenenado); a integração cobre cross-tenant e replay do fingerprint; os
  limites de pixels/páginas foram exportados e reutilizados pelo analyzer, sem
  duplicar constantes.

## Referência fiscal/QR: extração e normalização (F2.2a) (2026-10-23)

A F2.2a faz a ponte entre o documento enviado e o `FiscalAdapter` sem nenhuma
consulta fiscal real. Ela recebe uma referência **já extraída** (payload de QR,
URL, chave de acesso ou texto) e devolve um `FiscalReference` normalizado; a
extração física do QR (decodificar imagem) fica para a F2.2b.

- Contrato puro em `packages/core/src/fiscal-reference.ts`:
  `FiscalReference` (`status`, `source`, `issuer`, `uf`, `url`, `documentId`,
  `method`, `limitations`, `errorCodes`, `fingerprint`). Não há score,
  confiança, aprovação, autenticidade nem resultado de consulta.
- `status` distingue `found` / `not_found` / `inconclusive` / `unsupported`
  (contrato `2`; `inconclusive` foi acrescentado na F2.2b). Ausência de QR vira
  `not_found`, nunca documento inválido. `unsupported` cobre referência
  encontrada que não se consegue reconhecer com segurança; `inconclusive` cobre
  artefato que não foi possível analisar.
- `toFiscalLookupInput(reference, context)` recebe tenant/claim/artefato do
  **contexto confiável** do pipeline e só produz `FiscalLookupInput` quando
  `status = found` e há fonte. A referência não pode alterar tenant/claim/
  artefato.
- Extractor em `packages/providers/src/fiscal/reference.ts`. Reutiliza
  `isSafeExternalUrl` (F0.2) para rejeitar literalmente loopback/RFC1918/
  link-local/metadata, IPv6 privado, credenciais embutidas e `http`. Não faz
  fetch, HEAD, DNS lookup nem segue redirect.
- NF3e é reconhecida por padrão estrutural: host de autorizador documentado com
  o caminho esperado do endpoint de QR (`SVRS`/`SC`/`MG`/`MT`) **e/ou** chave de
  acesso de 44 dígitos estritamente numérica com UF válida, modelo `66` e DV
  módulo 11. Chave isolada válida produz `source = nf3e`, `uf` da chave e
  `issuer = null` (`UNKNOWN_ISSUER`). Parâmetros de chave duplicados/conflitantes
  retornam `AMBIGUOUS_REFERENCE`; valor não estrito retorna
  `INVALID_DOCUMENT_ID`.
- Allowlist de autorizadores continua vazia e server-side (F2.1); o extractor
  não autoriza endpoint. Domínio ou caminho desconhecido não vira autorizador:
  no máximo `issuer = null` quando há chave válida. NFAg-e é marcada
  `unsupported` (`SOURCE_NOT_SUPPORTED`).
- `limitations` registra condições informativas de uma referência `found`
  (`UNKNOWN_ISSUER`, `DOCUMENT_ID_MISSING`); `errorCodes` fica vazio em `found` e
  só recebe códigos em `unsupported`.
- Normalização determinística de URL: host minúsculo, sem fragmento, query
  ordenada. A mesma referência normalizada produz o mesmo `fingerprint` e o
  mesmo `FiscalLookupInput`; a idempotência final continua em
  `(claim_id, source, checker, checker_version)` (F2.1).
- Nenhuma dependência nova. Testes: 5 no core, 31 em providers e 3 de
  integração atravessando referência extraída → `FiscalLookupInput` →
  `FakeFiscalAdapter` → `claim_evidence`, com tenant isolation e sem rede.

## Contrato fiscal e materialização da observação (F2.1) (2026-10-23)

A F2.1 prepara a primeira fonte fiscal **sem executar nenhuma consulta real**.
Ela entrega o contrato `FiscalAdapter`, a normalização do resultado e a
materialização em `claim_evidence`; a NF3e real (allowlist preenchida, fetch e
parsing) fica para F2.2. Decisão em
[ADR-0041](docs/adr/0041-contrato-fiscal-adapter.md) e detalhes em
[`docs/arquitetura-evidencias.md`](docs/arquitetura-evidencias.md#55-contrato-fiscal-e-materialização-f21-implementado).

- Contrato puro em `packages/core/src/fiscal-verification.ts`: `FiscalAdapter`
  (`source`, `version`, `supports`, `verify`), `FiscalLookupInput` e
  `FiscalVerificationResult`. A entrada cobre `source` (`nf3e`/`nfag-e`),
  tenant, claim, chave/documento, QR (referência **não confiável**), autorizador,
  UF e artefato; **não** expõe endpoint, cookie, credencial HTTP ou fetch.
- Resultado separa `document`/fonte, `address` e `holder`. Reutiliza a taxonomia
  existente: `authentic` é o estado “verified” da fonte; não há valor paralelo.
  Timeout/indisponibilidade é `unavailable`, nunca `invalid`;
  `unavailable`/`inconclusive`/`unsupported` nunca viram `contradicts`.
- Materialização em `apps/worker/src/modules/fiscal-verification/fiscal-verification.service.ts`:
  uma linha em `claim_evidence` (`source = fiscal_nf3e`/`fiscal_nfag`) com as três
  dimensões em `detail.verification`, `strength = 0`, `confidence = 0` e **sem
  `signal`**. O score/veredito não mudam; a F3 decide peso e hard rules.
- O schema de saída remove `trust_score`, `final_score`, `approved` e `rejected`
  emitidos por um adapter. Nenhuma resposta bruta é persistida: só outcomes,
  `document_ref_hash`, versões, limitações, `uf`/`qr_present`, IP resolvido,
  status HTTP, hash do corpo e hash da URL pedida. A chave/URL crua não é
  copiada; logs usam apenas ids/status/reason codes.
- Idempotência e versão: chave `(claim_id, source, checker, checker_version)`,
  com
  `checker_version = <adapter_version>+a<adapter_source>+d<document_ref_hash>+c<contrato>[+o<transient_outcome>]`.
  Replay não duplica; `unavailable`/`inconclusive`/`unsupported` não bloqueiam
  um resultado terminal posterior; documentos diferentes no mesmo claim não
  colidem; nova versão preserva a anterior. Migração
  `0044_fiscal_evidence.sql` cria os índices parciais.
- Integridade: resultado de adapter com `documentId` divergente do input vira
  `unavailable` (`ADAPTER_RESULT_DOCUMENT_MISMATCH`); `limitations`/`errorCodes`
  usam allowlist finita e valores desconhecidos viram `ADAPTER_ERROR`.
- Tenant/RLS: leitura do claim/validation/endereço/titular e escrita usam
  `withTenant`; input de tenant A com claim de tenant B retorna `skipped` sem
  materializar. O loader de contexto foi extraído da F1.3 para
  `apps/worker/src/modules/evidence-verification/claim-context.ts`.
- SSRF: `packages/providers/src/fiscal/endpoint.ts` tem allowlist server-side
  por `(source, issuer, environment)`, **vazia por decisão**, e delega a chamada
  para a guarda única `safeExternalFetch` (ADR-0036). Endpoint fora da allowlist
  nem chega ao fetch; metadata/RFC1918 continuam bloqueados pela guarda. A URL
  do QR nunca é usada como destino.
- `FakeFiscalAdapter` determinístico (`packages/providers/src/fiscal/`) exercita
  o pipeline sem I/O. Testes: 9 no core, 10 em providers e 16 de integração
  (todos os status, endereço/titular independentes, SSRF/allowlist, timeout como
  `unavailable`, remoção de scoring, documento divergente, sanitização de
  reason codes, idempotência/transição para terminal, versionamento e
  cross-tenant).
- Fora de escopo (F2.2): parsing de QR NF3e, autorizadores/UF reais, HTTP/SOAP,
  certificado, cache/rate limit por fonte, descoberta de autorizador, detalhe
  fiscal no `GET` e NFAg-e.

## Intake de comprovante do cliente (F1.1) (2026-10-22)

`POST /v1/validations/:id/evidence` recebe um comprovante em multipart e grava
a observação pendente + o artefato, sem afirmar autenticidade ou endereço. O
contrato está em [ADR-0037](docs/adr/0037-intake-de-comprovante-do-cliente.md) e
em [`docs/arquitetura-evidencias.md`](docs/arquitetura-evidencias.md).

- Autenticação por API key existente (`validate:write`), tenant só da key;
  validação de outro tenant responde `404` (não `403`).
- Um arquivo por requisição; campos de texto e múltiplos arquivos são
  rejeitados. Limite default de 50 MiB (`EVIDENCE_MAX_BYTES` pode reduzir),
  aplicado no streaming + pré-checagem de `Content-Length`.
- Tipo por magic bytes: PDF, JPEG, PNG. `filename`, extensão e `Content-Type`
  declarado não definem o tipo; mismatch retorna `422`, tipo não suportado `415`.
- ObjectStore privado existente em
  `tenants/<tenant>/evidence/<artifact-id>`; SHA-256 calculado no servidor e
  conferido com o retorno do storage. Nenhuma URL pública/presigned.
- Cadeia `validation → claim → claim_evidence → evidence_artifact` em uma
  transação. Claim ausente em validation legada é criada com tipo derivado de
  `subject.doc_type`. `source = customer_submitted_document`, `stance = unknown`,
  `strength = 0`, `confidence = 0` (sem avaliação de verificação; campo
  `NOT NULL`), `detail.verification.status = "pending"`.
- Um documento do cliente por claim (índice único parcial). O SHA-256 é a chave
  natural: mesmos bytes são replay; bytes diferentes retornam `409`.
  `Idempotency-Key` identifica a tentativa do cliente, não a evidência:
  mesma key + mesmo conteúdo = replay; mesma key + conteúdo diferente = `422`;
  key nova + mesmo conteúdo = replay (alias), sem nova evidência.
- Lock da validation + índice único serializam uploads concorrentes; um semáforo
  por processo (`EVIDENCE_MAX_CONCURRENCY`, default 4) limita arquivos
  bufferizados em voo. Falha de DB/claim/artifact após o storage apaga o objeto;
  replay também apaga o objeto redundante. Falha do delete de compensação é
  logada com ids técnicos, sem filename/conteúdo/API key.
- `retention_until`/`expires_at` derivam de `validation.expires_at`; o job de
  retenção existente remove objeto e grafo. A resposta expõe só
  `evidence_id`, `artifact_id` e `status`; replay usa `200` +
  `Idempotent-Replayed: true`.
- Testes: `apps/api/tests/evidence-intake.int.test.ts` (17 casos, incluindo
  auth/scope, cross-tenant, traversal, MIME spoofing, vazio/ausente/limite,
  confiança neutra, idempotência por conteúdo/key, limite de uploads em voo,
  falha de storage/DB/claim, compensação sem PII e retenção). Migração
  `0040_evidence_intake.sql`.

O matching de documento/endereço/titular e o detalhe no `GET` foram entregues
na F1.3. Ainda faltam OCR de imagem e fontes fiscais (F2); a F1.1 continua sendo
o recibo imutável do upload.

## Análise do comprovante do cliente (F1.2) (2026-10-22)

O intake F1.1 passou a enfileirar `evidence_analysis` (`pending`) na mesma
transação do artefato; o worker extrai uma observação não confiável do PDF e
grava o resultado terminal. Upload, análise e verificação continuam etapas
distintas: a F1.2 **não** autentica o documento, **não** compara com o endereço
do claim e **não** altera `claim_evidence` nem o score. Contrato e decisão em
[ADR-0038](docs/adr/0038-analise-de-documento-do-cliente.md) e em
[`docs/arquitetura-evidencias.md`](docs/arquitetura-evidencias.md#53-análise-do-documento-do-cliente-f12-implementado).

> **Refatoração (2026-10-23, [ADR-0039](docs/adr/0039-extracao-de-pdf-com-unpdf.md)):**
> o parser PDF artesanal foi removido em favor de `unpdf`/PDF.js; a extração de
> campos passou a aceitar apenas rótulos explícitos; `kind` fica `unknown` e
> CPF/CNPJ não são persistidos. O contrato subiu para `2` e o analyzer para
> `1.1.0`. Idempotência, versionamento, append-only, worker, RLS e retenção não
> mudaram.

- Contrato `DocumentAnalysisResult` separa `document`, `address` e `holder`.
  Documento: `analyzed | invalid | inconclusive | unsupported | unavailable`;
  endereço/titular: `extracted | not_extracted | unknown`; análise:
  `completed | inconclusive | unsupported | unavailable | failed`.
  `authentic`, `matches` e `differs` são reservados ao verificador.
- Endereço extraído e normalizado (`logradouro`, `numero`, `complemento`,
  `bairro`, `cidade`, `uf`, `cep`) com `raw` mínimo da região para auditoria.
  Ausência de endereço é `not_extracted`, não falha.
- O nome do titular só é extraído quando rotulado; **CPF/CNPJ não são
  persistidos nesta etapa** (minimização de PII). Um identificador na mesma
  linha do nome é descartado. Não se infere CPF/CNPJ, relação familiar,
  propriedade ou residência.
- `kind` fica `unknown`; não há lista de concessionárias. `issuedAt` é uma
  observação de `Emissão`/`Competência` com data completa, não uma regra de
  validade.
- MVP sem OCR/VLM externo: o parsing de PDF fica com `unpdf`/PDF.js (streams,
  fontes, encoding, compressão) e o worker só orquestra e aplica limites (50
  páginas, 1.000.000 caracteres). Imagem retorna
  `unsupported`/`OCR_NOT_IMPLEMENTED`; PDFs escaneados/fontes sem `ToUnicode`
  retornam `inconclusive`/`NO_TEXT_LAYER`.
- Idempotência por `artifact_id`, `analyzer`, `analyzer_version` e
  `contract_version`: replay do upload não duplica; retry não reescreve
  resultado terminal; nova versão preserva a anterior. Concorrência usa
  `FOR UPDATE SKIP LOCKED` + chave única, sem Redis/Temporal/endpoint novo.
- `evidence_analysis` é append-only, tenant-scoped com RLS FORCE, FK composta
  `(artifact_id, tenant_id)` e `ON DELETE CASCADE` na retenção. O worker lê o
  objeto pelo `storage_key` opaco, confere tamanho/SHA-256 e nunca usa URL.
  Logs contêm apenas ids e razões técnicas; `result`/PII não são logados.
- `unavailable`, `inconclusive` e `unsupported` nunca viram `address=differs`
  nem `stance=contradicts`; desde a F1.3, o `GET /v1/validations/:id` expõe
  `evidence_verification` (ver seção F1.3).
- Testes: `apps/api/tests/evidence-analysis.int.test.ts` (15 casos: suporte,
  ausências, PDF inválido/sem texto, unsupported, unavailable, saída inválida do
  analisador, retry, replay, concorrência, cross-tenant, PII, retenção) e
  `packages/providers/src/document-analyzer.test.ts` (12 casos de contrato:
  PDF válido/comprimido, rótulos explícitos/ambíguos, ausências, PII, data,
  inválido, sem camada textual e imagem). Migração
  `0041_evidence_analysis.sql`. Gates da refatoração: `pnpm test` (79 arquivos,
  755 testes), `pnpm typecheck`, `pnpm lint`, `pnpm format` e `pnpm db:fence`
  (exit 0; warnings de lock/analisador dinâmico). `pnpm why unpdf` mostra uma
  única dependência direta em `@comprova/providers`.

## Verificação do documento enviado (F1.3) (2026-10-23)

O resultado da análise F1.2 agora é consumido e materializado como uma
observação de verificação em `claim_evidence`, sem alterar o score. O contrato
puro está em `packages/core/src/evidence-verification.ts`; a materialização
roda no worker (`apps/worker/src/modules/evidence-verification/`). Decisão em
[ADR-0040](docs/adr/0040-verificacao-do-documento-enviado.md) e em
[`docs/arquitetura-evidencias.md`](docs/arquitetura-evidencias.md#54-verificação-do-documento-enviado-f13-implementado).

- A linha F1.1 (`source = customer_submitted_document`,
  `checker = customer_document_intake`, `detail.verification.status = pending`)
  permanece **imutável** como recibo do intake. A F1.3 cria uma linha distinta
  com `source = uploaded_document`,
  `checker = document_upload_verification`, `stance = unknown`,
  `strength = 0`, `confidence = 0`, `evidence_sha256` do artefato e as três
  dimensões em `detail.verification`.
- `document` fica `inconclusive` quando a extração termina (um PDF legível não
  prova autenticidade); `invalid`, `unsupported` e `unavailable` são
  preservados. `address`/`holder` são `matches`, `differs` ou `not_extracted`.
  A política F1.3 mantém `stance = unknown`; `unavailable`, `inconclusive` e
  `unsupported` nunca viram `contradicts`.
- Endereço: CEP/UF/logradouro/número são fortes; bairro/cidade/complemento são
  de apoio. Igualdade exata após normalização, sem substring. Sem campo forte
  comparável ou sem `canonical_address`, `not_extracted`.
- Titular: igualdade exata após normalização e remoção de sufixos societários;
  sem nome extraído ou sem referência, `not_extracted`. Com razão social, nome
  diferente vira `differs`; com apenas nome fantasia, vira `not_extracted`
  (`HOLDER_REFERENCE_WEAK`), pois pode ser a razão social ausente. Não há
  inferência de sócio nem CPF/CNPJ.
- **Sem `signal`:** `weightedScore`, `score`, `confidence` e veredito da
  validation não mudam. A F3 decide se um match de conteúdo pode virar
  `supports`; a F2 traz `document = authentic` de fonte oficial.
- Idempotência por `(claim_id, checker, checker_version)` parcial para
  `source = uploaded_document`; `checker_version` inclui política +
  `analyzer_version` + `contract_version`. Replay não duplica; nova versão cria
  outra linha e preserva a anterior. A leitura corrente no `GET` é a verificação
  com `observed_at` mais recente (desempate `created_at`).
- Falha/skip não bloqueia outros tenants: o candidato é excluído do restante do
  tick e recebe backoff exponencial persistente (60 s → 1 h) em
  `evidence_verification_attempt` (`analysis_id`, tenant, tentativas e próxima
  tentativa; sem PII, admin-only). Sucesso remove a tentativa; a retenção apaga
  a análise e a tentativa em cascata.
- `GET /v1/validations/:id` passou a expor `evidence_verification` (objeto ou
  `null`) com status, método, fonte, `document`, `address`, `holder`,
  `analysis_id`, analisador/contrato, `observed_at`, limitações, erros e códigos
  de comparação. Não expõe nome, endereço, CEP, CPF/CNPJ nem `storage_key`.
- Tenant/RLS: a fila atravessa tenants com o pool admin, mas a leitura/escrita
  do claim usa `withTenant`; o candidato exige igualdade de tenant entre
  análise, artefato, intake e claim. Logs usam ids/status/razões; `detail` não
  copia PII.
- Testes: `packages/core/src/evidence-verification.test.ts` (21 casos de
  comparadores/mapeamento) e
  `apps/api/tests/evidence-verification.int.test.ts` (8 casos: matches,
  differs de endereço/titular, titular ausente, PDF sem texto, documento
  inválido, replay/nova versão, cross-tenant/RLS e PII, e skip/backoff sem
  bloquear outro tenant). Migrações `0042_evidence_verification.sql` e
  `0043_evidence_verification_attempt.sql`.
- Limitações: sem OCR de imagem (permanece `unsupported`), sem autenticação
  oficial do upload e sem retry de resultado terminal antigo. A F1.3 não
  implementa NF3e/NFAg-e, billing, link do titular nem wallet.
- Gates: `pnpm test` (81 arquivos, 784 testes), `pnpm typecheck`, `pnpm lint`,
  `pnpm format` e `pnpm db:fence` (exit 0; `0042_evidence_verification.sql`
  SAFE; `0043_evidence_verification_attempt.sql` MEDIUM por policy/lock de
  criação, dentro do limite; warnings legados de lock/analisador dinâmico).

## Guarda de fetch externo seguro (F0.2) (2026-10-22)

Uma única primitiva de saída, `safeExternalFetch`
(`packages/providers/src/safe-fetch.ts`), agora protege qualquer fetch externo
iniciado pelo servidor. O envio real de webhook passou a usá-la; a validação de
`isSafeWebhookUrl` no cadastro continua apenas como UX.

- HTTPS obrigatório, sem credenciais na URL, `localhost`/`*.localhost`
  bloqueados; `file:`, `ftp:`, `data:`, `javascript:` e desconhecidos falham.
- Resolve o host com `dns.lookup(all: true)`, valida **todos** os IPs e rejeita
  loopback, RFC1918, CGNAT, link-local, metadata de nuvem, IPv6
  unique-local/link-local e faixas reservadas. Um host público que resolve para
  IP privado falha.
- Anti-DNS-rebinding: o IP validado é devolvido pelo `lookup` do
  `https.request` (inclusive no formato `all: true` do `autoSelectFamily` do
  Node 22); não há segunda resolução.
- Redirects não são seguidos (3xx → `REDIRECT_BLOCKED`); limites de timeout
  (8 s default), conexão (3 s), corpo (256 KiB default), headers (16 KiB) e
  content-type opcional; resposta grande é interrompida.
- `SafeFetchError` expõe `reason` estruturado. O webhook loga apenas
  `reason`, `hostname` e `delivery_id` e grava o motivo em `last_error`; payload,
  segredo, assinatura e `Authorization` não aparecem no log.
- Dependência nova: `ipaddr.js` (classificação IPv4/IPv6). Nenhum segundo HTTP
  client: `node:https` + `node:dns/promises`.
- Testes: 58 casos da guarda (IP, DNS/rebinding, timeout de DNS, redirects,
  limites, content-type, timeout, servidor HTTPS local com CA de teste) e 8 de
  integração do webhook; cenário F2. Gates: `pnpm test` (73 arquivos, 689
  testes),
  `pnpm typecheck`, `pnpm lint`, `pnpm format` e `pnpm db:fence` (exit 0; sem
  migration nova).
- Decisão em [ADR-0036](docs/adr/0036-guarda-de-fetch-externo.md). Allowlist
  por autorizador fiscal/NF3e, upload, OCR, billing e wallet continuam fora.

## Artefato de evidência tenant-scoped (F0.1) (2026-10-22)

Fundação de armazenamento para documentos de cliente (PII) sem tocar em
`evidence`, que continua global e restrita ao street view. A nova tabela
`evidence_artifact` é tenant-scoped e ligada à observação por FK composta
`(claim_evidence_id, tenant_id)` — um artefato do tenant A não pode apontar para
`claim_evidence` do tenant B. O binário fica no `ObjectStore` existente
(`tenants/<tenant>/evidence/<artifact>`); o banco guarda só metadados,
`storage_key`, `sha256` e `retention_until`.

- Migration `0039_evidence_artifact.sql`: RLS ENABLE/FORCE, grants
  `SELECT/INSERT/DELETE` (sem `UPDATE`), trigger de imutabilidade, checks de
  tamanho/hash/content-type/namespace e unique `(tenant_id, storage_key)`.
- Serviço `apps/api/src/services/evidence-artifact.ts`: allowlist PDF/JPEG/PNG/
  WebP, limite de 50 MiB, hash local, compensação do storage se o INSERT falhar.
- Retenção: `validationRetentionTick` apaga o objeto, a linha do artefato e só
  então o grafo; a auditoria registra `artifacts_removed`.
- Testes: 15 de isolamento/integridade/lifecycle na API e retenção de artefato no
  worker. Gates: `pnpm test` (71 arquivos, 623 testes), `pnpm typecheck`,
  `pnpm lint`, `pnpm format`, `pnpm db:fence` (exit 0).
- Decisão em [ADR-0035](docs/adr/0035-artefato-de-evidencia-tenant-scoped.md).
  Upload/download HTTP, presigned URLs, OCR/VLM e NF3e/NFAg-e ficam fora.

## Auditoria de arquitetura, roadmap canônico e arquitetura de evidências (2026-10-22)

Auditoria documental do monorepo (sem mudança de código, schema, endpoint ou
dependência) para separar o que existe do que é intenção. O repositório não
tinha roadmap versionado — só este log e referências a um "roadmap #24" externo.

Novos documentos:

- [`docs/roadmap.md`](docs/roadmap.md) — roadmap canônico (P0–P3, fases F0–F8,
  dependências, critérios, riscos e decisões em aberto). Absorve o roadmap #24
  como concluído e reordena SSI/VLM/credencial.
- [`docs/arquitetura-evidencias.md`](docs/arquitetura-evidencias.md) — alvo de
  evidências (upload convencional + NF3e/NFAg-e), contrato de verificação,
  taxonomia, segurança de consulta externa, semântica temporal e extensões
  mínimas. Deixa explícito que nada disso está implementado.
- [`docs/adr/0033-verificacao-de-evidencias-por-adaptadores.md`](docs/adr/0033-verificacao-de-evidencias-por-adaptadores.md)
  — contrato de verificação com resultado em três dimensões e regra
  "indisponível ≠ contradiz".
- [`docs/adr/0034-consulta-a-fontes-fiscais-endpoints-oficiais.md`](docs/adr/0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
  — QR apenas identifica o autorizador; a URL de consulta vem de allowlist no
  servidor.

Correções de documentação: README (contagem de ADRs/runbooks e afirmação de
SSRF), `docs/architecture.md` (seção de evidências e policy global) e
`docs/lgpd/retencao.md` (o job de expiração já existe; detach de partição não).

Fatos externos verificados em 2026-10-22: NF3e (modelo 66) com autorizadores
MG/MS/MT/PR/SVRS/SC e QR por autorizador; NFAg-e (modelo 75) ainda como Minuta,
somente SVRS. Nenhuma cobertura nacional é assumida.

## Backend de assinatura AWS KMS (roadmap #24, etapa 24.3) (2026-10-21)

O `SigningKeyProvider` ganhou uma segunda implementação, selecionável por
`SIGNING_KEY_PROVIDER=aws-kms` (default `local`). O KMS **assina** os bytes e
devolve a assinatura; a privada nunca chega à aplicação, não há `GetPrivateKey`,
envelope/`Decrypt` nem material privado do KMS em memória. O provider local e
`CREDENTIAL_SIGNING_KEYS` continuam intactos.

Antes do código, a compatibilidade criptográfica foi auditada: o KMS suporta
Ed25519 com `ECC_NIST_EDWARDS25519` + `ED25519_SHA_512` + `MessageType: RAW`
(Pure EdDSA, FIPS 186-5 §7.6), exatamente o que `eddsa-jcs-2022` usa. Não foi
preciso mudar o formato da VC, o `proof`, o DID, o verificador nem a
`verificationMethod`. `ED25519_PH_SHA_512`/`DIGEST` (HashEdDSA) foi
deliberadamente descartado: o prehash duplo quebraria a verificação Pure EdDSA.

A migration `0038_issuer_signing_key_kms_reference.sql` adiciona
`issuer_signing_key.kms_key_reference` (NULL = local; ARN canônico = KMS) e
inclui a referência na identidade imutável do trigger. O provisionamento grava o
ARN devolvido pelo `GetPublicKey`, não o alias de entrada, e a pública continua
em `public_key` — a verificação pública segue local, sem consultar a AWS.

`SigningKeyEntry` virou uma união `local | kms`; `provisionSigningKeys` e
`rotateSigningKey` publicam a pública e a referência sem nunca tocar na privada
do KMS. Os comandos explícitos são
`pnpm db:provision-kms-key <tenant_id> <key_id> <kms_key_reference>` e
`pnpm db:rotate-kms-key <tenant_id> <new_key_id> <kms_key_reference>`; não há
migração automática das chaves existentes nem endpoint HTTP novo.

Testes: unidade do provider KMS com assinador fake (assinatura verificável,
`RAW`/`ED25519_SHA_512`, referência ausente, mismatch e falha do KMS) e do
`GetPublicKey` (ARN canônico, KeySpec/KeyUsage); integração com Postgres para
persistência da referência no provisionamento/rotação, leitura por
`loadActiveSigningKey` e imutabilidade no trigger. Nenhum teste chama a AWS real.
Credenciais continuam vindo da credential provider chain; `AWS_KMS_REGION` é
opcional e não há access key/secret no `.env`.

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
