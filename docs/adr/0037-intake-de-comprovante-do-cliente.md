# ADR-0037: Intake de comprovante do cliente (F1.1)

**Status:** aceita em 2026-10-22.

## Contexto

A F1.1 precisa receber um comprovante de endereço enviado pelo cliente, guardar
o binário em storage privado e registrar que o documento foi **apresentado**.
Autenticidade do documento, correspondência de endereço e vínculo com o titular
são fases posteriores (F1.2/F1.3). O modelo existente já tem
`validation → claim → claim_evidence` e o artefato tenant-scoped da F0.1
([ADR-0035](0035-artefato-de-evidencia-tenant-scoped.md)).

O risco principal é transformar upload em uma falsa confirmação de endereço, ou
criar uma hierarquia/tabela paralela que duplique o grafo de evidência.

## Decisão

1. **Anexar à validation existente.** `POST /v1/validations/:id/evidence` não
   cria uma validation nova. O tenant vem exclusivamente da API key; uma
   validation de outro tenant responde `404`.
2. **Um documento do cliente por claim.** A primeira submissão é write-once.
   Repetição com os mesmos bytes é replay idempotente; conteúdo diferente
   responde `409 EVIDENCE_ALREADY_EXISTS`. Outras fontes (fiscal, registry,
   street view) podem coexistir porque usam `source` diferente. A cardinalidade
   é garantida por `UNIQUE (claim_id) WHERE source = 'customer_submitted_document'`
   e serializada por lock da linha da validation.
3. **Semântica de pendência.** O upload grava `claim_evidence` com
   `source = 'customer_submitted_document'`, `checker = 'customer_document_intake'`,
   `stance = 'unknown'`, `strength = 0`, `confidence = 1` e
   `detail.verification = { status: 'pending', method: 'content_intake', document: null, address: null, holder: null }`.
   O upload prova apenas que o documento foi recebido; não soma score nem
   afirma endereço/titular.
4. **Artefato privado, chave e hash do servidor.** O binário vai para o
   `ObjectStore` privado existente em
   `tenants/<tenant-id>/evidence/<artifact-id>`. O filename do cliente nunca
   vira path. O SHA-256 é calculado dos bytes recebidos e conferido com o
   retorno do storage; hash do cliente não é aceito. Nenhuma URL pública ou
   presigned é persistida.
5. **Conteúdo, não header.** A allowlist é PDF, JPEG e PNG, verificada por
   assinatura/magic bytes. `Content-Type` declarado só é comparado depois da
   detecção; `application/octet-stream` é aceito quando o conteúdo é
   reconhecível. O limite default é 50 MiB (o mesmo do banco), configurável
   apenas para baixo.
6. **Idempotência em duas camadas.** O SHA-256 do conteúdo é a chave natural.
   Um `Idempotency-Key` opcional é gravado no
   `validation_idempotency` existente sob o namespace
   `evidence:<validation-id>:<client-key>`, com hash da solicitação
   (validation + tipo detectado + SHA-256). Reuso da mesma key com conteúdo
   diferente responde `422 IDEMPOTENCY_MISMATCH`.
7. **Compensação sem nova fila.** O objeto é gravado antes da transação. Se
   `claim_evidence`, `evidence_artifact` ou o marcador de idempotência falharem,
   a transação é desfeita e o objeto recém-gravado é apagado. Replay também
   apaga o objeto redundante. Se o delete de compensação falhar, o erro é
   registrado com identificadores técnicos seguros (sem filename/conteúdo) e o
   fluxo existente é mantido — não se cria outbox/fila só para isso.
8. **Retenção existente.** `evidence_artifact.retention_until` e
   `claim_evidence.expires_at` derivam de `validation.expires_at`; o job de
   retenção já existente apaga objeto e grafo. F1.1 não decide prazo comercial.
9. **Validation legada sem claim.** Se a validation ainda não tiver claim, o
   intake cria a claim canônica na mesma transação, derivando
   `type`/`subject_type` de `subject.doc_type` (`CNPJ` →
   `business_registered_address`/`organization`; `CPF` →
   `address_exists`/`person`). Isso preserva o invariante
   `validation → claim → claim_evidence` sem hierarquia paralela.
10. **Limite de uploads em voo.** Antes de bufferizar o arquivo
    (`part.toBuffer()`), o controller adquire um slot de um semáforo por
    processo (`EVIDENCE_MAX_CONCURRENCY`, default 4, máximo 16). O rate limit
    não limita requisições em voo; com burst 100 e 50 MiB por arquivo, um único
    tenant poderia reter ~4,9 GiB. O limite é por processo — réplicas
    multiplicam o total — e será substituído por streaming com SHA-256
    incremental quando o intake deixar de bufferizar o arquivo.

## Consequências

- O `GET /v1/validations/:id` existente passa a mostrar a observação pendente
  em `evidence_summary.unknown`; não há detalhe do documento na resposta até a
  extração de F1.2.
- Para trocar o documento, o cliente precisa de uma nova validation (ou de uma
  decisão futura que permita supersessão); não se sobrescreve evidência.
- O endpoint falha fechado (`503`) quando o storage não está configurado; não há
  fallback silencioso para memória.
- A autenticidade e o matching continuam explicitamente pendentes. Uma policy
  não pode tratar essa observação como `supports`.

## Alternativas rejeitadas

- **Múltiplos comprovantes por validation:** aumenta duplicidade e não há regra
  de escolha/independência; se necessário, será uma decisão nova.
- **Guardar o binário no Postgres:** PII e blobs no banco, fora do storage
  privado e da retenção existente.
- **Usar `stance = 'supports'`:** confundiria "documento recebido" com
  "endereço confirmado".
- **Criar `document`/`document_field`/`verification_attempt`:** schema sem
  segunda implementação e antes de existir extração real.
- **Confiar em filename/extensão/header:** permite spoofing e path traversal.
- **Criar outbox/fila de compensação:** operação síncrona simples; o padrão
  existente já registra a falha e permite reconciliação pelo par
  `(storage_key, linha)`.
