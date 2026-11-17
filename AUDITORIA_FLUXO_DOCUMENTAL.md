# Auditoria e Validação End-to-End do Fluxo Documental

Repositório: `leandroribeiro-ruel/comprova-endereco-monorepo`
Branch base: `main` (após merge do PR #71)
Status: Apenas auditoria e planejamento — sem alterações de código.

---

## 1. Resumo Executivo

O fluxo documental de comprovação de endereço pelo Holder está **implementado em partes, com lacunas críticas entre o intake (F1.1), o processamento da submissão do Holder (F4.2/F4.3) e o assessment documental (F1.2/F1.3 → deepEnrich)**.

Pontos fortes já entregues:

- Intake de comprovante via `/validations/:id/evidence` com validação de MIME/magic bytes, hash SHA-256, object storage tenant-scoped, idempotência, e enfileiramento de `evidence_analysis` na mesma transação.
- Solicitação de informações ao Holder (`holder_information_request`) com upload de documentos por item (`holder_information_request_document`), submissão atômica (`completed`), e emissão do evento de outbox `holder_submission.processing_requested`.
- Worker consome o outbox do Holder, cria `evidence_artifact` + `evidence_analysis` vinculados à solicitação, e marca o outbox como publicado.
- Análise F1.2 (extração via unpdf + Marker fallback) e verificação F1.3 (comparação de endereço/titular) existem.
- O deep path (deepEnrich + scoring + checkers T0/T1) está implementado e consumido pelo loop fiscal (F2.2b/F3).
- Ciclo de vida do worker com shutdown gracioso e isolamento de eventos internos no outbox (PR #71).

Lacunas críticas que impedem o fluxo end-to-end documental do Holder:

1. **Não há rota de consulta do resultado da submissão do Holder para o Verifier.** O Holder submete e o worker processa, mas não há endpoint que exponha ao Verifier o estado final (`holder_submission_processing`) nem vincule esse resultado à `validation`/`claim` do Verifier.
2. **O `evidence_artifact` e `evidence_analysis` criados pelo F4.3 têm `claimEvidenceId = null` e `holder_information_request_id` preenchido**, ou seja, não entram no domínio de `claim_evidence` → `signal` → assessment. Não há passo que materialize essa análise como observação de claim nem que reavalie a `validation` associada ao Holder.
3. **Não há ligação entre `holder_information_request` e `validation`.** A solicitação do Holder e a validação do Verifier são entidades independentes; não há FK nem campo que associe uma à outra. O evento de outbox carrega `tenant_id` e `holder_information_request_id`, mas não `validation_id`.
4. **Imagens (JPEG/PNG) não são processadas pelo OCR/Marker**: `analyzeDocument` retorna `unsupportedResult('OCR_NOT_IMPLEMENTED')` para imagens. O Document Intelligence só aceita PDF.

Recomendação: validar primeiro o caminho rápido (fast path de validação de endereço) antes de investir no caminho documental do Holder, pois o fast path já é end-to-end funcional (POST `/validations` → assessment síncrono → GET `/validations/:id`).

---

## 2. Diagrama do Fluxo Documental Real

```text
VERIFIER                                          HOLDER / WORKER
  |                                                 |
  | 1. POST /holders/:holderId/information-requests  |
  |------------------------------------------------->|
  |                                                 | 2. Holder recebe x-holder-token
  |                                                 | 3. PUT/POST documentos por item
  |                                                 | 4. POST /holder-access/submit
  |                                                 | 5. INSERT outbox
  |                                                 |    (holder_submission.processing_requested)
  |                                                 |------------------------------------------>
  |                                                 |            WORKER (holderSubmissionProcessingTick)
  |                                                 |            - Lê outbox (FOR UPDATE SKIP LOCKED)
  |                                                 |            - Cria evidence_artifact (holder_information_request_id)
  |                                                 |            - Cria evidence_analysis (pending)
  |                                                 |            - Marca outbox publicado
  |                                                 |------------------------------------------>
  |                                                 |
  | (FALTA: rota de consulta do resultado para o Verifier)
  | (FALTA: vinculação holder_information_request -> validation/claim)
  |                                                 |
  |  (PARALELO: fast path de validação de endereço)  |
  |  POST /validations                              |
  |------------------------------------------------->|
  |  - Intake de comprovante (F1.1)                 |
  |  - Worker: análise F1.2 (unpdf + Marker)        |
  |  - Worker: verificação F1.3                     |
  |  - Worker: fiscal NF3e (F2) + deepEnrich (F3)   |
  |  - GET /validations/:id (resultado)             |
  |<-------------------------------------------------|
```

---

## 3. Inventário de Arquivos, Serviços, Rotas e Tabelas

### Rotas HTTP (API)

| Método              | Path                                         | Arquivo                                | Função no fluxo documental                            |
| ------------------- | -------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| POST                | `/v1/holders/:holderId/information-requests` | `holder-information-request.routes.ts` | Verifier cria solicitação ao Holder                   |
| GET                 | `/v1/information-requests/:requestId`        | `holder-information-request.routes.ts` | Consulta da solicitação                               |
| POST                | `/v1/information-requests/:requestId/cancel` | `holder-information-request.routes.ts` | Cancelamento                                          |
| GET/PUT/POST/DELETE | `/v1/holder-access/*`                        | `holder-access.routes.ts`              | Holder acessa, salva itens, envia documentos, submete |
| POST                | `/v1/validations`                            | `validations.routes.ts`                | Cria validação de endereço (fast path)                |
| POST                | `/v1/validations/:id/evidence`               | `validations.routes.ts`                | Upload de comprovante (intake F1.1)                   |
| GET                 | `/v1/validations/:id`                        | `validations.routes.ts`                | Consulta resultado da validação                       |
| POST                | `/v1/documents/parse`                        | `documents.routes.ts`                  | Chama Document Intelligence (Marker)                  |

### Serviços da API

| Arquivo                                         | Função                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `holder-information-request.service.ts`         | CRUD de solicitações ao Holder                                                                                            |
| `holder-access.service.ts`                      | View, salvamento de itens, upload/delete de documentos, submissão (`submit`)                                              |
| `holder-submission-processing.service.ts` (API) | `getProcessing` para consulta do estado de processamento                                                                  |
| `evidence-intake.service.ts`                    | Upload de comprovante (F1.1): validação, storage, `claim_evidence` + `evidence_artifact` + `evidence_analysis`            |
| `validations.service.ts`                        | `getValidationDetails`: projeção do estado da validation, signals, evidence, progresso                                    |
| `validation-progress.ts`                        | Deriva etapas observáveis (reading_document, reading_qr, consulting_provider, verifying_authenticity, comparing_evidence) |
| `fastpath.ts`                                   | Fast path síncrono: checkers T0, scoring, persistência de validation + claim + claim_evidence + signal                    |

### Serviços do Worker

| Arquivo                                   | Loop                                       | Função                                                                                                  |
| ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `holder-submission-processing.service.ts` | `startHolderSubmissionProcessingLoop` (2s) | Consome outbox `holder_submission.processing_requested`, cria artefato+análise vinculados à solicitação |
| `evidence-analysis.service.ts`            | `startEvidenceAnalysisLoop` (2s)           | Consome `evidence_analysis` pendente, chama `DocumentAnalyzer`, persiste resultado terminal             |
| `evidence-verification.service.ts`        | `startEvidenceVerificationLoop` (2s)       | Materializa `claim_evidence` (uploaded_document) a partir de `evidence_analysis` terminal               |
| `fiscal-verification.tick.ts`             | `startFiscalVerificationLoop` (2s)         | Consulta NF3e via `FiscalAdapter`, chama `deepEnrich`, reavalia validation                              |
| `deep-enrich.service.ts`                  | (chamado por fiscal)                       | Assessment completo: T1 checkers, scoring, `claim_evidence`, resultado da validation                    |

### Pacotes

| Package               | Arquivo chave                                          | Função                                                                     |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `@comprova/providers` | `document-analyzer/analyze.ts`                         | Orquestra extração local (unpdf) + Marker fallback; extrai fiscalReference |
| `@comprova/providers` | `document-analyzer/marker.ts`                          | Adapter HTTP do serviço Marker                                             |
| `@comprova/providers` | `document-intelligence/client.ts`                      | Cliente HTTP do serviço Python (FastAPI)                                   |
| `@comprova/providers` | `object-store.ts`                                      | `ObjectStore`/`ObjectStoreReader` (S3 + fake)                              |
| `@comprova/core`      | `claim.ts`, `scoring.ts`, `policy.ts`, `assessment.ts` | Modelos de claim, scoring, decisão, policy                                 |
| `@comprova/core`      | `evidence-verification.ts`                             | `verifyUploadedDocument`: transforma análise em observação de verificação  |
| `@comprova/db`        | `schemas/claims.ts`                                    | `claim`, `claim_evidence`, `signal`                                        |
| `@comprova/db`        | `schemas/validations.ts`                               | `validation`, `validation_idempotency`                                     |
| `@comprova/db`        | `schemas/evidence-artifact.ts`                         | `evidence_artifact` (arquivo físico tenant-scoped)                         |
| `@comprova/db`        | `schemas/evidence-analysis.ts`                         | `evidence_analysis` (resultado estruturado da análise)                     |
| `@comprova/db`        | `schemas/holder-information-request.ts`                | `holder_information_request`                                               |
| `@comprova/db`        | `schemas/holder-information-request-document.ts`       | `holder_information_request_document`                                      |
| `@comprova/db`        | `schemas/holder-submission-processing.ts`              | `holder_submission_processing`                                             |
| `@comprova/db`        | `schemas/events.ts`                                    | `outbox`, `webhook_endpoint`, `webhook_delivery`                           |

### Serviço Document Intelligence (Python/FastAPI)

| Arquivo                                                          | Função                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/document-intelligence/src/document_intelligence/main.py`   | FastAPI: `/health`, `/ready`, `POST /documents/parse`                                    |
| `apps/document-intelligence/src/document_intelligence/parser.py` | `MarkerParser`: extração de texto, tabelas, imagens via Marker; `CONTRACT_VERSION = '4'` |
| `apps/document-intelligence/src/document_intelligence/queue.py`  | `ProcessingQueue`: admissão não-bloqueante com capacidade limitada                       |

### Tabelas de banco (relevantes ao fluxo documental)

| Tabela                                | Papel                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `holder_information_request`          | Solicitação do Verifier ao Holder                                                           |
| `holder_information_request_document` | Documento enviado pelo Holder (upload_state pending/stored, tombstone deletedAt)            |
| `holder_submission_processing`        | Estado de processamento da submissão (awaiting/processing/processed/partial/failed)         |
| `holder_access_token`                 | Token opaco de acesso do Holder                                                             |
| `holder_item_response`                | Respostas textuais do Holder por item                                                       |
| `holder_information_request_event`    | Auditoria de mudanças de estado                                                             |
| `evidence_artifact`                   | Arquivo físico (bytes em storage), vinculado a claim_evidence OU holder_information_request |
| `evidence_analysis`                   | Resultado estruturado da análise do documento                                               |
| `claim_evidence`                      | Observação lógica vinculada a um claim                                                      |
| `signal`                              | Sinal bruto de checker (particionado)                                                       |
| `claim`                               | Proposição verificada (endereço do CNPJ/CPF)                                                |
| `validation`                          | Unidade de trabalho, veredito, score, fiscal_reassessment                                   |
| `outbox`                              | Eventos transacionais (inclui `holder_submission.processing_requested`)                     |

---

## 4. Descrição de Cada Etapa do Processamento

### A1. Solicitação e Holder

1. Verifier chama `POST /v1/holders/:holderId/information-requests` → `createHolderInformationRequest` valida que o holder pertence ao tenant, cria a linha em `holder_information_request` (estado `pending`) e grava evento de auditoria `created`.
2. Verifier chama `POST /v1/information-requests/:requestId/access-tokens` → emite `holder_access_token` (hash HMAC-SHA-256, nunca texto puro).
3. Holder recebe `x-holder-token` e chama `GET /v1/holder-access` para ver a view da solicitação (itens, documentos já enviados).
4. Holder chama `PUT /v1/holder-access/items/:itemId` para salvar respostas textuais e `POST /v1/holder-access/items/:itemId/documents` para upload.
5. O upload (`uploadDocument`) valida MIME/magic bytes via `validateDocumentContent`, grava linha `pending` em `holder_information_request_document` **antes** do storage, então faz `store.put`, e finaliza marcando `stored` com SHA-256, contentType, sizeBytes. Há compensação se o storage falhar ou o finalize não puder ser commitado.
6. Holder chama `POST /v1/holder-access/submit` → transição atômica `pending/in_progress → completed` via `UPDATE ... WHERE state IN (...)`, grava evento `completed` e insere no `outbox` o evento `holder_submission.processing_requested` (aggregate `holder_information_request`, payload com `holder_information_request_id` e `tenant_id`).
7. Isolamento: o token é resolvido via função `SECURITY DEFINER` `app_resolve_holder_access_token` que valida prefixo + HMAC; dentro da transação, `lockRequestById` + `FOR UPDATE` garantem que token ↔ solicitação ↔ tenant ↔ Holder são coerentes. RLS por `tenant_id` protege as tabelas.

### A2. Upload e Armazenamento (Holder)

- Rotas: `POST /v1/holder-access/items/:itemId/documents` (upload), `DELETE /v1/holder-access/items/:itemId/documents/:documentId` (remoção com tombstone).
- Validação: `validateDocumentContent` verifica magic bytes e MIME; `maxDocumentBytes` limita tamanho.
- Integridade: SHA-256 calculado antes do storage e verificado após `store.put` (`stored.sha256.equals(sha256)` e `stored.bytes === data.byteLength`).
- Persistência: intenção `pending` no banco antes do storage; finalização `stored` após storage confirmado. Compensação remove objeto e intenção se houver falha.
- Estados intermediários: `pending` (intenção commitada, objeto pode não existir) e `stored` (objeto confirmado). `deletedAt` para exclusão lógica (tombstone).
- Isolamento: `storage_key` segue padrão `tenants/{tenantId}/holder-requests/{requestId}/{documentId}` com CHECK constraint; todas as queries filtram por `tenantId`.
- Risco: se o objeto for gravado no storage mas o `finalize` falhar e a compensação não conseguir remover o objeto, fica arquivo órfão no storage com intenção `pending` no banco. Não há cleanup automático de órfãos.

### A3. Worker e Processamento (Holder → outbox)

1. Loop `startHolderSubmissionProcessingLoop` roda a cada 2s, chama `holderSubmissionProcessingTick`.
2. O tick lê eventos do `outbox` com `aggregate = 'holder_information_request'` e `event_type = 'holder_submission.processing_requested'` e `published_at IS NULL`, com `FOR UPDATE SKIP LOCKED`, limitado por `batchSize` (default 10).
3. Para cada evento, abre transação tenant-scoped (`withTenant`):
   - Verifica se já existe `holder_submission_processing` em estado terminal (`processed`/`failed`); se sim, marca outbox publicado e segue.
   - Lista documentos ativos (`upload_state = 'stored'`, sem `deletedAt`) da solicitação.
   - Se não houver documentos, insere `holder_submission_processing` estado `processed` e marca outbox publicado.
   - Para cada documento, verifica se já existe `evidence_artifact` com mesmo `storage_key`; se não, cria com `claimEvidenceId = null`, `holder_information_requestId = requestId`. Insere `evidence_analysis` (pendente, idempotente).
   - Finaliza `holder_submission_processing` (`processed`/`partial`/`failed`) e marca outbox publicado.
4. Concorrência: `FOR UPDATE` na linha de processamento serializa workers concorrentes; `claimProcessing` no serviço da API também usa `FOR UPDATE` com backoff por staleness.
5. Após reinicialização do worker: eventos com `published_at IS NULL` são reprocessados; estado `processing` expirado pode ser reivindicado (`claimProcessing` com `staleMs`). Não há timeout explícito de processamento por documento.

### A4. Document Intelligence e OCR

1. O intake da API (`evidence-intake.service.ts`) detecta tipo de conteúdo via magic bytes (`detectDocumentContentType`): aceita `application/pdf`, `image/jpeg`, `image/png`.
2. Para PDF: `evidence-analysis.service.ts` carrega o artefato do storage, verifica hash SHA-256, e chama `deps.analyzer.analyze({ data, contentType })`.
3. O analyzer (`analyze.ts`) tenta extração de texto local via `unpdf` (`extractText`). Se a camada local não entregar titular E endereço, e o Document Intelligence estiver configurado, chama o Marker via `makeDocumentIntelligenceClient` → `POST /documents/parse`.
4. O serviço Document Intelligence (Python/FastAPI) roda Marker 2.1.0 com warmup, fila de admissão (429 se capacidade esgotada), timeout configurável, e retorna JSON estruturado (texto, tabelas, elementos).
5. O analyzer combina fontes (texto local, texto Marker, tabelas Marker) com comparação explícita; divergência vira ausência + limitação observável (`FIELD_CONFLICT_ADDRESS/HOLDER`).
6. Extração de referência fiscal (QR/chave de acesso) é feita no caminho determinístico local (unpdf), **não** pelo OCR do Marker.
7. Imagens JPEG/PNG: `analyzeDocument` retorna `unsupportedResult('OCR_NOT_IMPLEMENTED')`. Não há OCR de imagens nesta entrega. VLM não é usado (conforme decisão arquitetural).

### A5. Evidence Analysis e Evidence Verification

1. **F1.2 (Análise):** `evidence_analysis` recebe linha `pending` (criada pelo intake F1.1 ou pelo F4.3). O worker reivindica com `FOR UPDATE SKIP LOCKED`, marca `analyzing`, executa o analyzer, e persiste resultado terminal (`completed`/`inconclusive`/`unsupported`/`unavailable`/`failed`) com `result` JSONB e `analyzedAt`. Idempotente por `(artifact_id, analyzer, analyzer_version, contract_version)`.
2. **F1.3 (Verificação):** `verifyEvidenceTick` consome `evidence_analysis` terminal com `source = customer_submitted_document`, chama `verifyUploadedDocument` (compara endereço/titular extraídos com o target da validation), e insere `claim_evidence` com `source = 'uploaded_document'`, `checker = 'document_upload_verification'`, `stance` sempre `unknown` (política conservadora: o upload não autentica o documento). Única linha por `(claim_id, checker, checker_version)`.
3. **F2 (Fiscal):** `verifyFiscalTick` consome análises com `fiscalReference.status = 'found'`, consulta o `FiscalAdapter` (NF3e), e chama `deepEnrich` (reassess). Insere `claim_evidence` com `source = 'fiscal_nf3e'`.
4. **Assessment (deepEnrich):** Combina sinais T1 (checkers) com observações sem signal (intake F1.1, uploaded_document F1.3, fiscal F2), executa `evaluateClaim` (scoring com decaimento por TTL), decide veredito, persiste `validation` (veredito, score, confidence, `evidence_set_hash`, `policy_hash`, `scorer_version`, `completed_at`) e emite eventos de outcome no outbox.

### A6. Reavaliação da Claim

- O serviço que dispara a reavaliação é o loop fiscal (`verifyFiscalTick`), que chama `deps.reassess(tenantId, validationId)` → `deepEnrich`.
- O `deepEnrich` carrega o estado da validation (`loadValidationState`), executa checkers T1 (e T2 se ambíguo), lê evidências standalone (`readStandaloneEvidenceSet`), avalia via `evaluateClaim`, persiste `updateValidationOutcome`, e opcionalmente revoga credenciais anteriores (`supersedeIssuedCredentials` se o resultado mudar).
- Checkers T0 participam do fast path (`fastpath.ts`); checkers T1 participam do deep path. Não há checkers T2 no MVP (`buildT2Checkers` retorna `[]`).
- Fontes complementares: NF3e via `FiscalAdapter` (consulta à SEFAZ por QR/chave de acesso). Não substitui a comprovação documental.
- Score/veredito: `weightedScore` com decaimento por TTL e `decide` (hard rules, thresholds `confirmed_threshold`, `insufficient_band`). `confidenceFrom` calcula cobertura e acordo.
- Resultados inconclusivos: `INSUFFICIENT_EVIDENCE` com `completed_at` NULL até uma conclusão terminal; `partial` não grava `completed_at`.
- Nova evidência altera uma claim já avaliada: `deepEnrich` pode ser reexecutado; replay idêntico preserva `completed_at`; resultado novo grava novo instante.

### A7. Resultado para o Verifier

- API de consulta: `GET /v1/validations/:id` → `getValidationDetails` retorna validation (status, verdict, score, confidence, explanation, fiscal_reassessment), signals, claim, evidenceSummary, evidenceVerification (últimimo `uploaded_document`), fiscalVerification, fiscalReferenceStatus, progresso (`buildValidationProgress`), endereço.
- Dashboard do Verifier: não inspecionado nesta auditoria (não há arquivos de dashboard no escopo de rotas mapeados).
- Webhooks: eventos `validation.completed`, `validation.updated`, `validation.contested`, `validation.blocked_quota`, `batch.completed`, `subject.erased` publicados via outbox para endpoints inscritos.
- Estados de processamento: `validation.status` (`completed`/`partial`/`queued`/`failed`/`expired`), `validation.fiscal_reassessment` (`pending`/`completed`), progresso das 5 etapas.
- Evidências e justificativas: `validation.explanation` (summary, code, supporting_evidence, contradicting_evidence), `claim_evidence.detail` (verificação com outcomes e reason codes, nunca valores brutos de endereço/titular).
- Proteção de dados: `document_hash` do holder é hash (não CPF/CNPJ claro); `claim_evidence.detail` não copia endereço/titular extraídos; `evidence_artifact` é tenant-scoped e retido 30 dias.
- Consistência: o GET lê o estado persistido; `buildValidationProgress` projeta estados duráveis já gravados pelo worker.

---

## 5. Estado Atual de Cada Etapa

| Etapa                                 | Componente                                         | Estado                                                 |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Solicitação ao Holder                 | `holder-information-request.service.ts`            | Completo                                               |
| Upload de documentos pelo Holder      | `holder-access.service.ts`                         | Completo (com compensação de storage)                  |
| Submissão do Holder                   | `holder-access.service.ts` `submit`                | Completo (evento de outbox emitido)                    |
| Consumo do outbox pelo Worker         | `holder-submission-processing.service.ts` (worker) | Completo                                               |
| Criação de artefato+análise do Holder | Worker tick                                        | Completo (mas `claimEvidenceId = null`)                |
| Análise F1.2 (PDF local + Marker)     | `evidence-analysis.service.ts`                     | Completo para PDF; ausente para imagem                 |
| Verificação F1.3                      | `evidence-verification.service.ts`                 | Completo (para `customer_submitted_document`)          |
| Consulta fiscal NF3e                  | `fiscal-verification.tick.ts`                      | Completo                                               |
| Assessment/deepEnrich                 | `deep-enrich.service.ts`                           | Completo                                               |
| Resultado para o Verifier (Holder)    | **ausente**                                        | Não há rota nem vinculação holder_request → validation |
| Resultado para o Verifier (fast path) | `GET /v1/validations/:id`                          | Completo                                               |
| OCR de imagens                        | `analyzeDocument`                                  | Ausente (retorna `unsupported`)                        |

---

## 6. Etapa B: Integridade e Segurança (Análise Transversal)

### 6.1 Isolamento entre tenants

- Todas as tabelas do fluxo documental têm `tenant_id` e são acessadas via `withTenant(db, tenantId, ...)`.
- `holder_information_request`, `holder_information_request_document`, `holder_submission_processing`, `evidence_artifact`, `evidence_analysis`, `claim_evidence`, `signal`, `validation`, `claim`, `subject` — todas filtram por `tenant_id`.
- Holder access: o token resolve tenant via função `SECURITY DEFINER`; dentro da transação é revalidado `tenant_id` no token e na solicitação.
- RLS: tabelas protegidas por RLS por `tenant_id` (conforme migrations). Não foi verificado se o RLS está habilitado ativamente (`ALTER TABLE ENABLE ROW LEVEL SECURITY`) em todas as tabelas, nem se as policies restringem corretamente.

### 6.2 Autorização entre Holder, solicitação, documento e Claim

- `authorizeInTx` faz `lockRequestById` (`FOR UPDATE`), valida `holderId`, verifica token ativo (não revogado, não expirado), e checa estados mutáveis vs legíveis.
- Não há verificação explícita de que o Holder que submete é o mesmo titular do documento/comprovante — a associação é feita pelo `holder_information_request_id` e pelo `holderId` da solicitação.
- Não há ligação autorizativa entre a submissão do Holder e a `validation` do Verifier (não há FK nem campo comum).

### 6.3 Integridade referencial e consistência das transações

- `submit` faz tudo em uma transação: UPDATE da solicitação + evento de auditoria + INSERT no `outbox`. Atomicidade preservada.
- `uploadDocument`: intenção `pending` commitada antes do storage; se o storage falhar, compensação remove objeto e intenção. Se o `finalize` falhar após storage, compensação tenta remover objeto e intenção. Se a remoção do objeto falhar, a intenção permanece para reconciliação manual (não há cleanup automático).
- `evidence_artifact` tem check constraint "exatamente um de claimEvidenceId ou holder_information_request_id". O F4.3 preenche `holder_information_requestId` e deixa `claimEvidenceId = null`.

### 6.4 Idempotência

- Intake F1.1: idempotência por `validation_id + idempotency_key + request_hash` (hash do conteúdo). Replay por conteúdo também detectado.
- `evidence_analysis`: único por `(artifact_id, analyzer, analyzer_version, contract_version)`.
- `claim_evidence`: único por `(claim_id, checker, checker_version)` para `uploaded_document`; único por `(claim_id, source, checker, checker_version)` para fiscal.
- `holder_submission_processing`: único por `holder_information_request_id`; `onConflictDoUpdate` na finalização.
- Outbox `holder_submission.processing_requested`: não há dedup de evento; se a submissão for reenviada, um novo evento é inserido, mas o processamento é idempotente (estado terminal impede reprocessamento).

### 6.5 Concorrência entre Workers

- `holderSubmissionProcessingTick` usa `FOR UPDATE SKIP LOCKED` no outbox e `FOR UPDATE` na linha de processamento. Dois workers não processam o mesmo evento simultaneamente.
- `claimProcessing` (API) usa `FOR UPDATE` com backoff por staleness (`updatedAt < staleBefore`).
- Não há lease persistido nem timeout global de processamento por submissão.

### 6.6 Recuperação de processamento interrompido

- Eventos com `published_at IS NULL` são reprocessados após reinicialização.
- Estado `processing` expirado pode ser reivindicado (`staleMs`).
- `evidence_analysis` em `analyzing` expirado (`claimStaleMs`, default 5min) é reivindicado novamente.
- Tentativas excedem `maxAttempts` (default 5) → terminaliza como `failed`.

### 6.7 Auditoria das mudanças de estado

- `holder_information_request_event` grava todas as transições: `created`, `holder_accessed`, `holder_response_saved`, `holder_document_uploaded`, `holder_document_removal_requested`, `holder_document_removed`, `completed`, `expired`, `cancelled`, `access_token_revoked`.
- `audit_log` para validações (`validation.create`, `validation.contested`).
- Não há tabela de auditoria genérica para mudanças de `holder_submission_processing` (são inferidas por `state` + `updated_at` + `last_error`).

### 6.8 Proteção contra acesso indevido aos arquivos

- Object storage é privado: `get` recebe chave opaca, nunca URL. Não há endpoint público de download de artefatos.
- `storage_key` com prefixo tenant-scoped + CHECK constraint.
- Holder access responses usam `Cache-Control: no-store`.

### 6.9 Duplicação, perda ou associação incorreta de evidências

- `evidence_artifact.storage_key` único por tenant (`evidence_artifact_tenant_storage_key_uq`).
- `claim_evidence.evidence_sha256` sobrevive à retenção do artefato.
- Risco: F4.3 cria artefatos com `claimEvidenceId = null`; se o objeto for removido do storage (retenção 30 dias), a linha de `evidence_analysis` é removida por `ON DELETE CASCADE` (FK composta), mas o histórico de que o documento foi processado permanece em `holder_submission_processing`.

---

## 7. Etapa C: Testes e Cobertura

### Testes existentes identificados

| Arquivo                                                               | Tipo                             | O que cobre                                        |
| --------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| `apps/api/tests/holder-information-request.int.test.ts`               | Integração (Docker)              | CRUD de solicitações ao Holder                     |
| `apps/api/tests/holder-access.int.test.ts`                            | Integração (Docker)              | Upload/delete/submit de documentos do Holder       |
| `apps/api/tests/holder-access-rls.int.test.ts`                        | Integração (Docker)              | RLS do holder access                               |
| `apps/api/tests/validations*` (diversos)                              | Integração (Docker)              | Fast path, intake, evidence                        |
| `apps/api/tests/fiscal-verification.int.test.ts`                      | Integração (Docker)              | Loop fiscal NF3e                                   |
| `apps/api/tests/modules/webhooks/f2.int.test.ts`                      | Integração (Docker)              | Outbox publisher + entregas                        |
| `apps/api/tests/modules/webhooks/webhook-safe-fetch.int.test.ts`      | Integração (Docker)              | Safe fetch webhooks                                |
| `apps/api/tests/modules/webhooks/outbox-holder-isolation.int.test.ts` | Integração (Docker, novo PR #71) | Isolamento de eventos internos do outbox           |
| `apps/worker/src/modules/retention/retention.int.test.ts`             | Integração (Docker)              | Retenção de validações                             |
| `apps/worker/src/modules/deep-enrich/deep-enrich.int.test.ts`         | Integração (Docker)              | Deep enrich F3/F4                                  |
| `apps/worker/src/modules/deep-enrich/deep-enrich.f3.int.test.ts`      | Integração (Docker)              | Vertical slice F3                                  |
| `apps/worker/src/modules/deep-enrich/deep-enrich.f4.int.test.ts`      | Integração (Docker)              | Vertical slice F4                                  |
| `apps/worker/src/loops.test.ts`                                       | Unitário (vitest)                | startLoop: ticks, stop, in-flight                  |
| `apps/worker/src/lifecycle.test.ts`                                   | Unitário (vitest)                | runWorkerLifecycle: sinais, shutdown, boot failure |
| `apps/worker/src/closePools.test.ts`                                  | Unitário (vitest)                | closePools: todos os pools, falha parcial          |
| `apps/worker/src/config.test.ts`                                      | Unitário (vitest)                | workerEnvFromProcess                               |
| `packages/providers/src/document-analyzer/*.test.ts`                  | Unitário (vitest)                | Analyzer, Marker adapter                           |
| `packages/providers/src/document-intelligence/client.test.ts`         | Unitário (vitest)                | Cliente Document Intelligence                      |

### Cobertura por etapa do fluxo

| Etapa                       | Testes unitários                                   | Testes de integração                     | Cobertura   |
| --------------------------- | -------------------------------------------------- | ---------------------------------------- | ----------- |
| Solicitação Holder          | Não identificado                                   | `holder-information-request.int.test.ts` | Parcial     |
| Upload documentos Holder    | Não identificado                                   | `holder-access.int.test.ts`              | Parcial     |
| Submissão Holder → outbox   | `outbox-holder-isolation.int.test.ts`              | Sim                                      | Parcial     |
| Consumo outbox Worker       | Não identificado                                   | Não identificado                         | **Ausente** |
| Análise F1.2                | `document-analyzer/*.test.ts`                      | Não identificado                         | Parcial     |
| Verificação F1.3            | Não identificado                                   | `validations*`                           | Parcial     |
| Fiscal NF3e                 | Não identificado                                   | `fiscal-verification.int.test.ts`        | Parcial     |
| Deep enrich                 | `deep-enrich*.test.ts`                             | `deep-enrich.int.test.ts`, f3, f4        | Parcial     |
| Resultado Verifier (Holder) | —                                                  | —                                        | **Ausente** |
| OCR de imagens              | —                                                  | —                                        | **Ausente** |
| Isolamento tenants          | `rls.int.test.ts`, `holder-access-rls.int.test.ts` | Sim                                      | Parcial     |

### Cenários importantes sem cobertura (mínimo solicitado)

1. Upload de conta de energia válida — Parcial (holder-access.int.test.ts)
2. Upload de conta de água válida — Não identificado
3. PDF com camada textual — Parcial (document-analyzer)
4. PDF sem camada textual exigindo OCR — Parcial (Marker fallback em analyze.ts, mas não há teste de integração com serviço real)
5. Imagem JPEG/PNG — **Ausente** (retorna unsupported, sem teste)
6. Documento ilegível — Parcial (testes de analisador com PDF inválido)
7. Documento sem endereço identificável — Parcial (limitations NO_TEXT_LAYER)
8. Documento com endereço divergente — Parcial (FIELD_CONFLICT_ADDRESS)
9. Documento expirado/fora de validade — Não identificado explicitamente
10. Falha do serviço de OCR — Parcial (testes de fallback do Marker)
11. Worker interrompido durante processamento — **Ausente** (não há teste de interrupção/reinicialização)
12. Retry após falha — Parcial (maxAttempts, backoff, mas não teste de fluxo completo)
13. Submissão duplicada — Parcial (idempotência de holder_submission_processing)
14. Duas solicitações simultâneas para o mesmo Holder — **Ausente**
15. Acesso a documento de outra solicitação — Parcial (holder-access tests de autorização)
16. Acesso entre tenants diferentes — Parcial (RLS tests)
17. Reavaliação da Claim após nova evidência — Parcial (deep-enrich testes, mas não fluxo completo Holder)

---

## 8. Etapa D: Problemas e Classificação

### P0 — Problemas confirmados (bloqueiam o fluxo principal)

| ID   | Arquivo                                                                                                         | Comportamento atual                                                                                                                                                                                            | Esperado                                                                                                               | Impacto                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P0-1 | `apps/api/src/modules/holder/holder-access.service.ts` (submit) + ausência de rota                              | O Holder submete e o worker processa, mas não há rota para o Verifier consultar o resultado da submissão do Holder, nem vinculação entre `holder_information_request` e `validation`                           | Endpoint de consulta do resultado da submissão e associação à validation/claim do Verifier                             | O fluxo documental do Holder não é visível ao Verifier; o processamento F4.3 fica "preso" no worker |
| P0-2 | `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts` (linhas 148-170) | `evidence_artifact` criado com `claimEvidenceId = null` e `holder_information_requestId` preenchido; não há passo que materialize essa análise como observação de `claim_evidence` nem reavalie a `validation` | O artefato/analise do Holder deve entrar no assessment ou haver caminho explícito para o Verifier consumir o resultado | As evidências do Holder não influenciam o veredito da Claim                                         |
| P0-3 | `packages/providers/src/document-analyzer/analyze.ts` (linha 705-710)                                           | Imagens JPEG/PNG retornam `unsupportedResult('OCR_NOT_IMPLEMENTED')`                                                                                                                                           | Suporte a OCR de imagens (ou pelo menos erro claro e tratamento)                                                       | Documentos de comprovante em imagem não são processados                                             |

### P1 — Necessário para operar com segurança no primeiro piloto

| ID   | Arquivo                                                                                                    | Comportamento atual                                                                                  | Esperado                                                                                           | Impacto                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P1-1 | `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts` (linha 168) | `retentionUntil` fixo em 30 dias (`new Date(Date.now() + 30 * 86_400_000)`) para artefatos do Holder | Retenção alinhada com a política de dados (ver `docs/lgpd/retencao.md` referenciada no comentário) | Risco LGPD: retenção além do necessário                                   |
| P1-2 | `packages/db/src/schemas/holder-submission-processing.ts`                                                  | Não há tabela de auditoria para mudanças de `state` do processamento                                 | Tabela de eventos de auditoria para `holder_submission_processing`                                 | Dificuldade de rastrear quem/quando alterou o estado                      |
| P1-3 | `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts`             | Não há timeout explícito de processamento por submissão; apenas `attempts` e `last_error`            | Timeout máximo de processamento + alerta/métrica de submissões travadas                            | Submissões podem ficar em `processing` indefinidamente se o worker travar |

### P2 — Melhorias importantes (não bloqueiam piloto)

| ID   | Arquivo                                                                  | Comportamento atual                                                                                 | Esperado                                     | Impacto                              |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| P2-1 | `apps/worker/src/modules/evidence-analysis/evidence-analysis.service.ts` | Não há métrica de tempo de processamento por documento                                              | Métrica de duração da análise                | Observabilidade limitada             |
| P2-2 | `apps/api/src/modules/holder/holder-access.service.ts`                   | `compensateUpload` não remove objeto se delete falhar; intenção permanece para reconciliação manual | Cleanup automático de órfãos (job periódico) | Acúmulo de objetos órfãos no storage |

### P3 — Evolução futura

| ID   | Descrição                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------- |
| P3-1 | Checkers T2 (Street View, OpenAI Vision) — fora do escopo MVP (`buildT2Checkers` retorna `[]`) |
| P3-2 | SSI, OpenID4VCI, OpenID4VP — fora do escopo desta etapa                                        |

### Riscos potenciais (não confirmados)

| ID  | Descrição                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | RLS pode não estar habilitado ativamente em todas as tabelas do fluxo documental (não verificado via migrations)                                   |
| R-2 | Não há limitação de taxa específica para upload de documentos do Holder além do rate limiting geral (`rateLimits.upload`)                          |
| R-3 | O `outbox` do Holder não tem dedup de evento; submissões duplicadas geram múltiplos eventos (processamento é idempotente, mas eventos se acumulam) |
| R-4 | Falha no storage após intenção `pending` e antes do `finalize` pode deixar objeto órfão se a compensação falhar                                    |

### Decisões arquiteturais que precisam de confirmação

| ID  | Descrição                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Como o resultado da submissão do Holder deve ser vinculado à `validation` do Verifier? (criar nova validation? adicionar campo `holder_information_request_id` à validation? novo tipo de claim?) |
| D-2 | O `evidence_artifact` do Holder deve ser reutilizado pelo fluxo de validação (F1.1) ou permanece isolado no domínio F4?                                                                           |

---

## 9. Etapa E: Proposta de Execução (Plano de PRs)

### PR 1: Consulta do resultado da submissão do Holder para o Verifier

**Objetivo:** Expor ao Verifier o estado de processamento da submissão do Holder e vincular à validation.

**Problemas resolvidos:** P0-1.

**Arquivos envolvidos:**

- `apps/api/src/modules/holder/holder-information-request.routes.ts` (nova rota GET)
- `apps/api/src/modules/holder/holder-information-request.service.ts` (novo serviço de consulta)
- `apps/api/src/modules/holder/holder-information-request.controller.ts` (novo controller)
- `apps/api/src/modules/holder/holder-access.controller.ts` (endpoint `getProcessing` já existe; expor para Verifier)
- `apps/api/src/app.ts` (registrar rota)

**Dependências:** Nenhuma (usa `holder_submission_processing` existente).

**Testes necessários:** Teste de integração: Verifier consulta resultado de submissão de Holder que já foi processada pelo worker.

**Critérios de aceite:**

- GET retorna `processingId`, `state`, `attempts`, `lastError`, `processedAt`.
- Apenas o Verifier dono da solicitação (mesmo tenant) pode consultar.
- 404 se não existir processamento.

**Riscos de regressão:** Baixo (apenas leitura).

---

### PR 2: Vinculação da submissão do Holder à validation/claim do Verifier

**Objetivo:** Permitir que as evidências do Holder participem do assessment da claim.

**Problemas resolvidos:** P0-2.

**Arquivos envolvidos:**

- `apps/api/src/modules/holder/holder-information-request.service.ts` (adicionar `validation_id` opcional à solicitação)
- `packages/db/src/schemas/holder-information-request.ts` (adicionar coluna `validation_id`)
- `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts` (após criar análise, disparar `deepEnrich` ou materializar `claim_evidence`)
- `apps/worker/src/modules/deep-enrich/deep-enrich.service.ts` (possível ajuste para aceitar `holder_information_request_id`)

**Dependências:** PR 1 (rota de consulta), definição da decisão arquitetural D-1.

**Testes necessários:** Teste de integração: submissão do Holder resulta em atualização da `validation` vinculada.

**Critérios de aceite:**

- A solicitação do Holder pode ser associada a uma `validation_id`.
- O processamento F4.3 resulta em observação de `claim_evidence` vinculada ao claim da validation.
- O veredito da validation reflete as evidências do Holder.

**Riscos de regressão:** Médio (altera schema e domínio de claim).

---

### PR 3: Suporte a OCR de imagens (JPEG/PNG)

**Objetivo:** Processar documentos de comprovante em formato de imagem.

**Problemas resolvidos:** P0-3.

**Arquivos envolvidos:**

- `packages/providers/src/document-analyzer/analyze.ts` (ramo de imagem)
- `packages/providers/src/document-intelligence/client.ts` (suportar imagem no parse)
- `apps/document-intelligence/src/document_intelligence/main.py` (aceitar imagem no endpoint)
- `apps/document-intelligence/src/document_intelligence/parser.py` (OCR de imagem via Marker)

**Dependências:** Nenhuma.

**Testes necessários:** Teste de unidade: `analyzeDocument` com imagem retorna análise concluída (não `unsupported`). Teste de integração com serviço Document Intelligence real (se disponível).

**Critérios de aceite:**

- Imagem JPEG/PNG válida produz `DocumentAnalysisResult` com `status = 'completed'` ou `inconclusive` (não `unsupported`).
- Imagem corrompida retorna erro apropriado.

**Riscos de regressão:** Baixo (novo ramo de código, não altera caminho existente de PDF).

---

### PR 4: Retenção e cleanup de artefatos do Holder

**Objetivo:** Alinhar retenção de artefatos do Holder com política LGPD e evitar órfãos.

**Problemas resolvidos:** P1-1, P2-2.

**Arquivos envolvidos:**

- `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts` (uso de `retentionUntil` configurável)
- `apps/worker/src/modules/evidence/evidence-retention.service.ts` (estender para artefatos de holder, se aplicável)
- Novo job de cleanup de órfãos (opcional)

**Dependências:** Nenhuma.

**Testes necessários:** Teste de unidade: `retentionUntil` respeita valor configurado.

**Critérios de aceite:**

- Artefatos do Holder têm `retentionUntil` alinhado com a política.
- Não há órfãos persistentes após falha de compensação (ou job de cleanup).

**Riscos de regressão:** Baixo.

---

### PR 5: Auditoria de mudanças de estado do processamento do Holder

**Objetivo:** Rastrear mudanças de `state` em `holder_submission_processing`.

**Problemas resolvidos:** P1-2.

**Arquivos envolvidos:**

- Novo arquivo de tabela/migration ou reuso de `holder_information_request_event`
- `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts` (gravar evento em cada transição)

**Dependências:** Nenhuma.

**Critérios de aceite:** Cada transição de `state` gera um evento de auditoria persistido.

**Riscos de regressão:** Baixo.

---

### PR 6: Timeout e alerta de submissões travadas

**Objetivo:** Detectar submissões do Holder que ficam em `processing` indefinidamente.

**Problemas resolvidos:** P1-3.

**Arquivos envolvidos:**

- `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts` (campo de timeout ou verificação de idade)
- Métrica de submissões travadas

**Dependências:** Nenhuma.

**Critérios de aceite:** Submissão em `processing` além de limite configurável é detectada e logada/métrica emitida.

**Riscos de regressão:** Baixo.

---

## 10. Critérios Objetivos para o Fluxo Documental Operacional

O fluxo documental de comprovação de endereço será considerado operacional quando:

1. **Pontos de entrada funcionam:** Verifier cria solicitação ao Holder; Holder faz upload e submete documentos; submissão é recebida pelo worker.
2. **Processamento completo:** Worker cria artefato + análise; análise é executada (PDF local + Marker fallback); resultado é persistido com status terminal.
3. **Resultado visível:** Verifier consegue consultar o estado da submissão (via API) e vê o impacto na validation/claim (se vinculada).
4. **Isolamento preservado:** Nenhum Holder acessa documentos/solicitações de outro Holder ou de outro tenant.
5. **Concorrência segura:** Dois workers não processam a mesma submissão simultaneamente; submissões duplicadas são idempotentes.
6. **Recuperação:** Após reinicialização do worker, submissões pendentes são retomadas.
7. **Imagens suportadas:** JPEG/PNG são processados (não retornam `unsupported`).
8. **Testes passando:** Todos os testes de integração do fluxo documental passam em ambiente com Docker.

---

## 11. Problemas Fora do Escopo

Os seguintes problemas foram observados mas estão fora do escopo desta auditoria (fluxo documental):

1. **RLS ativo:** Não verificado se `ALTER TABLE ENABLE ROW LEVEL SECURITY` está aplicado em todas as tabelas do fluxo documental.
2. **Webhooks de entrega:** Semântica de eventos externos sem endpoint inscrito (publicado sem delivery) — já documentado no PR #71.
3. **Concorrência do outbox publisher:** `FOR UPDATE SKIP LOCKED` fora de transação explícita — identificado no PR #71 como etapa posterior.
4. **Dashboard do Verifier:** Não há arquivos de dashboard no escopo de rotas mapeados; não foi inspecionado.
5. **Metering/usage:** Eventos de uso para validações do Holder (se aplicável) — não mapeado.
6. **Credenciais verificáveis:** Emissão de VC após validação documental — fora do escopo desta etapa.
7. **Temporal:** Não reintroduzir (decisão arquitetural).

O relatório está completo. Aguardo aprovação do plano antes de implementar qualquer correção.
