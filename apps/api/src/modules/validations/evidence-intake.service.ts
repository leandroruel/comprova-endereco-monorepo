import { problem, problems, type Problem } from '@comprova/contracts'
import {
  CUSTOMER_DOCUMENT_INTAKE_CHECKER,
  CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  CUSTOMER_DOCUMENT_INTAKE_STATUS,
  addressClaimForSubjectDocType,
  type AddressClaimSpec,
} from '@comprova/core'
import { and, eq, insertPendingEvidenceAnalysis, withTenant, type Db, type DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { sha256Of, type ObjectStore } from '@comprova/providers'
import { createHash, randomUUID } from 'node:crypto'
import {
  insertEvidenceArtifact,
  storeEvidenceObject,
  type StoredEvidenceObject,
} from '../../services/evidence-artifact.js'
import {
  detectDocumentContentType,
  normalizeDocumentContentType,
  type DocumentContentType,
} from '../../services/document-content.js'

/**
 * F1.1 — intake seguro do comprovante.
 *
 * O upload NÃO afirma que o documento é autêntico nem que o endereço/titular
 * correspondem. Ele cria uma observação `unknown`/`pending` em `claim_evidence`
 * (`source = customer_submitted_document`) e o artefato físico tenant-scoped.
 * A análise/verificação é F1.2/F1.3.
 */

export const EVIDENCE_INTAKE_SOURCE = CUSTOMER_DOCUMENT_INTAKE_SOURCE
export const EVIDENCE_INTAKE_CHECKER = CUSTOMER_DOCUMENT_INTAKE_CHECKER
export const EVIDENCE_INTAKE_CHECKER_VERSION = CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION
export const EVIDENCE_INTAKE_STATUS = CUSTOMER_DOCUMENT_INTAKE_STATUS

export const EVIDENCE_INTAKE_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const

export type EvidenceIntakeContentType = DocumentContentType

const INTAKE_CONTENT_TYPE_SET: ReadonlySet<string> = new Set(EVIDENCE_INTAKE_CONTENT_TYPES)

const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
])

export interface EvidenceIntakeDeps {
  readonly db: Db
  readonly store: ObjectStore
  readonly logger: Logger
  readonly maxBytes: number
}

export interface EvidenceIntakeInput {
  readonly tenantId: string
  readonly validationId: string
  readonly data: Uint8Array
  readonly declaredContentType: string | undefined
  readonly idempotencyKey: string | undefined
}

export interface EvidenceIntakeResult {
  readonly evidenceId: string
  readonly artifactId: string
  readonly status: 'pending'
  readonly replayed: boolean
}

export class EvidenceIntakeError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title)
    this.name = 'EvidenceIntakeError'
  }
}

const notFound = (): EvidenceIntakeError => new EvidenceIntakeError(problems.notFound('validation'))

const idempotencyMismatch = (): EvidenceIntakeError =>
  new EvidenceIntakeError(
    problem(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency key used with different request body'),
  )

const persistenceFailed = (): EvidenceIntakeError =>
  new EvidenceIntakeError(problems.evidencePersistenceFailed())

const normalizeDeclaredContentType = normalizeDocumentContentType

/**
 * Sniffing dos formatos aceitos. Não confia em filename, extensão ou no
 * `Content-Type` declarado: o tipo persistido é sempre o detectado aqui.
 */
export const detectEvidenceIntakeContentType = (data: Uint8Array): EvidenceIntakeContentType | null =>
  detectDocumentContentType(data)

const resolveContentType = (
  data: Uint8Array,
  declaredContentType: string | undefined,
  maxBytes: number,
): EvidenceIntakeContentType => {
  if (data.byteLength === 0) throw new EvidenceIntakeError(problems.evidenceEmpty())
  if (data.byteLength > maxBytes) throw new EvidenceIntakeError(problems.evidenceTooLarge())

  const detected = detectEvidenceIntakeContentType(data)
  if (detected === null) throw new EvidenceIntakeError(problems.unsupportedEvidenceType())

  const declared = normalizeDeclaredContentType(declaredContentType)
  if (declared === null || GENERIC_CONTENT_TYPES.has(declared)) return detected
  if (!INTAKE_CONTENT_TYPE_SET.has(declared)) {
    throw new EvidenceIntakeError(problems.unsupportedEvidenceType())
  }
  if (declared !== detected) throw new EvidenceIntakeError(problems.evidenceContentMismatch())
  return detected
}

const evidenceRequestHash = (
  validationId: string,
  contentType: EvidenceIntakeContentType,
  sha256: Buffer,
): string =>
  createHash('sha256')
    .update(`evidence:${validationId}:${contentType}:${sha256.toString('hex')}`)
    .digest('hex')

const idempotencyStorageKey = (validationId: string, idempotencyKey: string): string =>
  `evidence:${validationId}:${idempotencyKey}`

interface ExistingEvidence {
  readonly claimEvidenceId: string
  readonly artifactId: string | null
  readonly sha256: Buffer | null
  readonly contentType: string | null
}

interface IdempotencyMarker {
  readonly validationId: string
  readonly requestHash: string | null
}

interface IntakeValidation {
  readonly validationId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly addressId: string | null
  readonly expiresAt: Date
}

const loadValidation = async (
  tx: DbTx,
  validationId: string,
  lock: boolean,
): Promise<IntakeValidation | undefined> => {
  const query = tx
    .select({
      validationId: t.validation.validationId,
      tenantId: t.validation.tenantId,
      subjectId: t.validation.subjectId,
      addressId: t.validation.addressId,
      expiresAt: t.validation.expiresAt,
    })
    .from(t.validation)
    .where(eq(t.validation.validationId, validationId))
    .limit(1)
  const rows = lock ? await query.for('update') : await query
  const validation = rows[0]
  // Validation expirada não recebe nova evidência: o grafo entra em remoção
  // pela retenção. Tratada como inexistente (404), inclusive para replay —
  // o cliente cria uma nova validation para enviar outro documento.
  if (validation !== undefined && validation.expiresAt.getTime() <= Date.now()) return undefined
  return validation
}

const loadSubjectDocType = async (tx: DbTx, validation: IntakeValidation): Promise<string> => {
  const subjectRows = await tx
    .select({ docType: t.subject.docType })
    .from(t.subject)
    .where(and(eq(t.subject.subjectId, validation.subjectId), eq(t.subject.tenantId, validation.tenantId)))
    .limit(1)
  const docType = subjectRows[0]?.docType
  if (docType === undefined) throw new Error('validation subject missing')
  return docType
}

/**
 * Claim de endereço da Validation, derivada de `subject.docType` com a mesma
 * regra do ADR-0037 (CNPJ → `business_registered_address`/`organization`;
 * demais → `address_exists`/`person`). Outras Claims da Validation pertencem a
 * outras finalidades e nunca são candidatas. Duas Claims da mesma finalidade
 * configuram inconsistência e falham fechado.
 */
const loadAddressClaimId = async (
  tx: DbTx,
  validation: IntakeValidation,
  spec: AddressClaimSpec,
): Promise<string | undefined> => {
  const rows = await tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(
      and(
        eq(t.claim.tenantId, validation.tenantId),
        eq(t.claim.validationId, validation.validationId),
        eq(t.claim.type, spec.type),
        eq(t.claim.subjectType, spec.subjectType),
      ),
    )
  if (rows.length > 1) throw new EvidenceIntakeError(problems.evidencePersistenceFailed())
  return rows[0]?.claimId
}

const loadExistingEvidence = async (tx: DbTx, claimId: string): Promise<ExistingEvidence | undefined> => {
  const rows = await tx
    .select({
      claimEvidenceId: t.claimEvidence.claimEvidenceId,
      artifactId: t.evidenceArtifact.artifactId,
      sha256: t.evidenceArtifact.sha256,
      contentType: t.evidenceArtifact.contentType,
    })
    .from(t.claimEvidence)
    .leftJoin(
      t.evidenceArtifact,
      and(
        eq(t.evidenceArtifact.claimEvidenceId, t.claimEvidence.claimEvidenceId),
        eq(t.evidenceArtifact.tenantId, t.claimEvidence.tenantId),
      ),
    )
    .where(and(eq(t.claimEvidence.claimId, claimId), eq(t.claimEvidence.source, EVIDENCE_INTAKE_SOURCE)))
    .limit(1)
  return rows[0]
}

type CustomerDocumentLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'canonical'; readonly evidence: ExistingEvidence }
  | { readonly kind: 'other-claim' }

const loadReceiptsForValidation = async (
  tx: DbTx,
  tenantId: string,
  validationId: string,
): Promise<readonly { readonly claimId: string }[]> =>
  tx
    .select({ claimId: t.claimEvidence.claimId })
    .from(t.claimEvidence)
    .innerJoin(
      t.claim,
      and(eq(t.claim.claimId, t.claimEvidence.claimId), eq(t.claim.tenantId, t.claimEvidence.tenantId)),
    )
    .where(
      and(
        eq(t.claim.tenantId, tenantId),
        eq(t.claim.validationId, validationId),
        eq(t.claimEvidence.source, EVIDENCE_INTAKE_SOURCE),
      ),
    )

/**
 * Recibo já existente para a Validation. A relação `validation_customer_document`
 * é a fonte autoritativa; o recibo só é reutilizável se estiver na Claim de
 * endereço resolvida. O fallback pela Claim cobre recibos legados anteriores à
 * relação explícita; um recibo em outra finalidade é inconsistência, nunca
 * reaproveitamento.
 */
const loadCustomerDocument = async (
  tx: DbTx,
  tenantId: string,
  validationId: string,
  claimId: string,
): Promise<CustomerDocumentLookup> => {
  const [link] = await tx
    .select({
      claimEvidenceId: t.validationCustomerDocument.claimEvidenceId,
      claimId: t.claimEvidence.claimId,
      artifactId: t.evidenceArtifact.artifactId,
      sha256: t.evidenceArtifact.sha256,
      contentType: t.evidenceArtifact.contentType,
    })
    .from(t.validationCustomerDocument)
    .innerJoin(
      t.claimEvidence,
      and(
        eq(t.claimEvidence.claimEvidenceId, t.validationCustomerDocument.claimEvidenceId),
        eq(t.claimEvidence.tenantId, t.validationCustomerDocument.tenantId),
      ),
    )
    .leftJoin(
      t.evidenceArtifact,
      and(
        eq(t.evidenceArtifact.claimEvidenceId, t.claimEvidence.claimEvidenceId),
        eq(t.evidenceArtifact.tenantId, t.claimEvidence.tenantId),
      ),
    )
    .where(
      and(
        eq(t.validationCustomerDocument.tenantId, tenantId),
        eq(t.validationCustomerDocument.validationId, validationId),
      ),
    )
    .limit(1)

  if (link !== undefined) {
    if (link.claimId !== claimId) return { kind: 'other-claim' }
    return {
      kind: 'canonical',
      evidence: {
        claimEvidenceId: link.claimEvidenceId,
        artifactId: link.artifactId,
        sha256: link.sha256,
        contentType: link.contentType,
      },
    }
  }

  const existing = await loadExistingEvidence(tx, claimId)
  if (existing !== undefined) return { kind: 'canonical', evidence: existing }

  const receipts = await loadReceiptsForValidation(tx, tenantId, validationId)
  return receipts.length === 0 ? { kind: 'none' } : { kind: 'other-claim' }
}

/**
 * Materializa a relação 1:1 recibo ↔ Validation. `validation_id` é PK: se já
 * existir um vínculo para outra linha, o pedido falha como `409`, sem substituir
 * o documento existente.
 */
const linkValidationCustomerDocument = async (
  tx: DbTx,
  input: { readonly tenantId: string; readonly validationId: string; readonly claimEvidenceId: string },
): Promise<void> => {
  await tx
    .insert(t.validationCustomerDocument)
    .values({
      validationId: input.validationId,
      claimEvidenceId: input.claimEvidenceId,
      tenantId: input.tenantId,
    })
    .onConflictDoNothing()

  const [link] = await tx
    .select({ claimEvidenceId: t.validationCustomerDocument.claimEvidenceId })
    .from(t.validationCustomerDocument)
    .where(
      and(
        eq(t.validationCustomerDocument.tenantId, input.tenantId),
        eq(t.validationCustomerDocument.validationId, input.validationId),
      ),
    )
    .limit(1)

  if (link === undefined || link.claimEvidenceId !== input.claimEvidenceId) {
    throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
  }
}

const loadIdempotency = async (
  tx: DbTx,
  tenantId: string,
  idempotencyKey: string,
): Promise<IdempotencyMarker | undefined> => {
  const rows = await tx
    .select({
      validationId: t.validationIdempotency.validationId,
      requestHash: t.validationIdempotency.requestHash,
    })
    .from(t.validationIdempotency)
    .where(
      and(
        eq(t.validationIdempotency.tenantId, tenantId),
        eq(t.validationIdempotency.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)
  return rows[0]
}

const matches = (
  existing: ExistingEvidence,
  contentType: EvidenceIntakeContentType,
  sha256: Buffer,
): boolean =>
  existing.artifactId !== null &&
  existing.sha256 !== null &&
  existing.contentType === contentType &&
  existing.sha256.equals(sha256)

const replayOf = async (
  tx: DbTx,
  input: EvidenceIntakeInput,
  existing: ExistingEvidence,
): Promise<EvidenceIntakeResult> => {
  if (existing.artifactId === null) throw persistenceFailed()
  // Replay do mesmo conteúdo também garante uma linha de análise para a
  // versão corrente. `ON CONFLICT DO NOTHING` preserva a análise terminal da
  // mesma versão e permite que uma nova versão do analisador seja aplicada a
  // um artefato já existente.
  await insertPendingEvidenceAnalysis(tx, {
    tenantId: input.tenantId,
    artifactId: existing.artifactId,
  })
  return {
    evidenceId: existing.claimEvidenceId,
    artifactId: existing.artifactId,
    status: EVIDENCE_INTAKE_STATUS,
    replayed: true,
  }
}

const ensureClaim = async (tx: DbTx, validation: IntakeValidation): Promise<string> => {
  const spec = addressClaimForSubjectDocType(await loadSubjectDocType(tx, validation))
  const existing = await loadAddressClaimId(tx, validation, spec)
  if (existing !== undefined) return existing

  await tx
    .insert(t.claim)
    .values({
      claimId: randomUUID(),
      tenantId: validation.tenantId,
      validationId: validation.validationId,
      subjectId: validation.subjectId,
      addressId: validation.addressId,
      type: spec.type,
      subjectType: spec.subjectType,
      targetType: 'address',
    })
    .onConflictDoNothing()

  const claimId = await loadAddressClaimId(tx, validation, spec)
  if (claimId === undefined) throw new Error('claim insert failed')
  return claimId
}

const recordIdempotency = async (
  tx: DbTx,
  input: EvidenceIntakeInput,
  requestHash: string,
): Promise<void> => {
  if (input.idempotencyKey === undefined) return
  await tx
    .insert(t.validationIdempotency)
    .values({
      tenantId: input.tenantId,
      idempotencyKey: idempotencyStorageKey(input.validationId, input.idempotencyKey),
      validationId: input.validationId,
      requestHash,
      responseAddress: null,
    })
    .onConflictDoNothing()
}

const preflight = async (
  deps: EvidenceIntakeDeps,
  input: EvidenceIntakeInput,
  contentType: EvidenceIntakeContentType,
  sha256: Buffer,
  requestHash: string,
): Promise<
  { readonly kind: 'upload' } | { readonly kind: 'replay'; readonly result: EvidenceIntakeResult }
> =>
  withTenant(deps.db, input.tenantId, async (tx) => {
    const validation = await loadValidation(tx, input.validationId, false)
    if (validation === undefined) throw notFound()

    const marker =
      input.idempotencyKey === undefined
        ? undefined
        : await loadIdempotency(
            tx,
            input.tenantId,
            idempotencyStorageKey(input.validationId, input.idempotencyKey),
          )

    if (marker !== undefined) {
      if (marker.validationId !== input.validationId || marker.requestHash !== requestHash) {
        throw idempotencyMismatch()
      }
    }

    const spec = addressClaimForSubjectDocType(await loadSubjectDocType(tx, validation))
    const claimId = await loadAddressClaimId(tx, validation, spec)
    const existing =
      claimId === undefined
        ? ({ kind: 'none' } as const)
        : await loadCustomerDocument(tx, input.tenantId, input.validationId, claimId)

    if (marker !== undefined) {
      if (existing.kind !== 'canonical' || !matches(existing.evidence, contentType, sha256)) {
        throw persistenceFailed()
      }
      return { kind: 'replay' as const, result: await replayOf(tx, input, existing.evidence) }
    }
    if (existing.kind === 'none') return { kind: 'upload' as const }
    if (existing.kind === 'other-claim') {
      // Recibo da Validation está em outra finalidade: nunca o reutiliza.
      throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
    }
    if (matches(existing.evidence, contentType, sha256)) {
      // Replay por conteúdo com uma key nova: registra o alias para que um
      // reuso dessa key com outro conteúdo seja detectado como mismatch.
      await recordIdempotency(tx, input, requestHash)
      return { kind: 'replay' as const, result: await replayOf(tx, input, existing.evidence) }
    }
    throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
  })

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const errorCodeOf = (error: unknown, depth = 0): string | null => {
  if (depth > 3 || typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  // Drizzle 0.45 embrulha o erro do driver em `DrizzleQueryError.cause`.
  return errorCodeOf((error as { cause?: unknown }).cause, depth + 1)
}

const errorConstraintOf = (error: unknown, depth = 0): string | null => {
  if (depth > 3 || typeof error !== 'object' || error === null) return null
  // postgres.js expõe `constraint_name`; alguns wrappers normalizam para
  // `constraint`. Cobrimos os dois para a barreira do índice continuar sendo
  // traduzida em 409.
  const withConstraint = error as { constraint_name?: unknown; constraint?: unknown }
  if (typeof withConstraint.constraint_name === 'string') return withConstraint.constraint_name
  if (typeof withConstraint.constraint === 'string') return withConstraint.constraint
  return errorConstraintOf((error as { cause?: unknown }).cause, depth + 1)
}

const DUPLICATE_CUSTOMER_DOCUMENT_CONSTRAINTS: ReadonlySet<string> = new Set([
  'idx_claim_evidence_customer_document_uq',
  'validation_customer_document_pkey',
  'validation_customer_document_claim_evidence_uq',
])

const isDuplicateCustomerDocument = (error: unknown): boolean => {
  const constraint = errorConstraintOf(error)
  return (
    errorCodeOf(error) === '23505' &&
    constraint !== null &&
    DUPLICATE_CUSTOMER_DOCUMENT_CONSTRAINTS.has(constraint)
  )
}

const compensate = async (
  deps: EvidenceIntakeDeps,
  input: EvidenceIntakeInput,
  object: StoredEvidenceObject,
  trigger: string,
): Promise<void> => {
  try {
    await deps.store.delete(object.storageKey)
  } catch (error) {
    deps.logger.warn(
      {
        tenant_id: input.tenantId,
        validation_id: input.validationId,
        artifact_id: object.artifactId,
        reason: 'EVIDENCE_COMPENSATION_FAILED',
        trigger,
        error_name: errorNameOf(error),
        error_code: errorCodeOf(error),
      },
      'evidence storage compensation failed',
    )
  }
}

/**
 * Fluxo: valida o conteúdo → storage → transação única (claim_evidence +
 * evidence_artifact + marcador de idempotência). Se o banco falhar depois do
 * storage, o objeto é apagado. Se a transação encontrar replay, o objeto
 * recém-gravado também é apagado e a evidência existente é devolvida.
 */
export const uploadEvidence = async (
  deps: EvidenceIntakeDeps,
  input: EvidenceIntakeInput,
): Promise<EvidenceIntakeResult> => {
  const contentType = resolveContentType(input.data, input.declaredContentType, deps.maxBytes)
  const sha256 = sha256Of(input.data)
  const requestHash = evidenceRequestHash(input.validationId, contentType, sha256)

  let pre: Awaited<ReturnType<typeof preflight>>
  try {
    pre = await preflight(deps, input, contentType, sha256, requestHash)
  } catch (error) {
    if (error instanceof EvidenceIntakeError) throw error
    deps.logger.error(
      {
        tenant_id: input.tenantId,
        validation_id: input.validationId,
        reason: 'EVIDENCE_PREFLIGHT_FAILED',
        error_name: errorNameOf(error),
        error_code: errorCodeOf(error),
      },
      'evidence preflight failed',
    )
    throw new EvidenceIntakeError(problems.evidencePersistenceFailed())
  }
  if (pre.kind === 'replay') return pre.result

  let object: StoredEvidenceObject
  try {
    object = await storeEvidenceObject(deps, {
      tenantId: input.tenantId,
      data: input.data,
      contentType,
    })
  } catch (error) {
    deps.logger.warn(
      {
        tenant_id: input.tenantId,
        validation_id: input.validationId,
        reason: 'EVIDENCE_STORAGE_PUT_FAILED',
        error_name: errorNameOf(error),
        error_code: errorCodeOf(error),
      },
      'evidence storage put failed',
    )
    throw new EvidenceIntakeError(problems.evidenceStorageUnavailable())
  }

  try {
    const result = await withTenant(deps.db, input.tenantId, async (tx) => {
      // Serializa uploads da mesma validation mesmo quando uma validation
      // legada ainda não tem claim; o índice parcial do banco é a segunda
      // barreira contra duplicação.
      const validation = await loadValidation(tx, input.validationId, true)
      if (validation === undefined) throw notFound()
      const claimId = await ensureClaim(tx, validation)

      const marker =
        input.idempotencyKey === undefined
          ? undefined
          : await loadIdempotency(
              tx,
              input.tenantId,
              idempotencyStorageKey(input.validationId, input.idempotencyKey),
            )
      if (marker !== undefined) {
        if (marker.validationId !== input.validationId || marker.requestHash !== requestHash) {
          throw idempotencyMismatch()
        }
      }

      const existing = await loadCustomerDocument(tx, input.tenantId, input.validationId, claimId)
      if (marker !== undefined) {
        if (existing.kind !== 'canonical' || !matches(existing.evidence, contentType, sha256)) {
          throw persistenceFailed()
        }
        await linkValidationCustomerDocument(tx, {
          tenantId: input.tenantId,
          validationId: input.validationId,
          claimEvidenceId: existing.evidence.claimEvidenceId,
        })
        return replayOf(tx, input, existing.evidence)
      }
      if (existing.kind === 'other-claim') {
        throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
      }
      if (existing.kind === 'canonical') {
        if (!matches(existing.evidence, contentType, sha256)) {
          throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
        }
        // Recibo legado ainda sem a relação explícita: adota o vínculo 1:1.
        await linkValidationCustomerDocument(tx, {
          tenantId: input.tenantId,
          validationId: input.validationId,
          claimEvidenceId: existing.evidence.claimEvidenceId,
        })
        await recordIdempotency(tx, input, requestHash)
        return replayOf(tx, input, existing.evidence)
      }

      const now = new Date()
      const ttlSeconds = Math.max(0, Math.floor((validation.expiresAt.getTime() - now.getTime()) / 1000))
      const claimEvidenceId = randomUUID()

      await tx.insert(t.claimEvidence).values({
        claimEvidenceId,
        tenantId: input.tenantId,
        claimId,
        signalId: null,
        evidenceId: null,
        evidenceSha256: sha256,
        checker: EVIDENCE_INTAKE_CHECKER,
        checkerVersion: EVIDENCE_INTAKE_CHECKER_VERSION,
        // O upload só prova que um documento foi apresentado. A F1.2 extrai
        // campos e a F1.3 materializa a verificação em OUTRA linha; esta linha
        // continua `unknown` como recibo do intake. `confidence` é NOT NULL,
        // então o valor neutro 0 expressa ausência de avaliação, não negação.
        stance: 'unknown',
        strength: 0,
        confidence: 0,
        source: EVIDENCE_INTAKE_SOURCE,
        observedAt: now,
        ttlSeconds,
        expiresAt: validation.expiresAt,
        detail: {
          verification: {
            status: EVIDENCE_INTAKE_STATUS,
            method: 'content_intake',
            document: null,
            address: null,
            holder: null,
          },
          artifact: {
            content_type: contentType,
            size_bytes: input.data.byteLength,
          },
        },
      })

      // Relação 1:1 recibo ↔ Validation imposta pelo banco. Uma corrida com o
      // worker F4.3 (que também cria o recibo sob o mesmo lock) não duplica:
      // o conflito é traduzido em 409 e a transação é desfeita.
      await linkValidationCustomerDocument(tx, {
        tenantId: input.tenantId,
        validationId: input.validationId,
        claimEvidenceId,
      })

      await insertEvidenceArtifact(tx, {
        tenantId: input.tenantId,
        claimEvidenceId,
        object,
        retentionUntil: validation.expiresAt,
      })
      // F1.2: enfileira a análise na MESMA transação do intake. A análise não
      // altera a observação `unknown`/`pending` da F1.1; o verificador F1.3
      // consumirá a linha de `evidence_analysis`.
      await insertPendingEvidenceAnalysis(tx, {
        tenantId: input.tenantId,
        artifactId: object.artifactId,
      })
      await recordIdempotency(tx, input, requestHash)

      return {
        evidenceId: claimEvidenceId,
        artifactId: object.artifactId,
        status: EVIDENCE_INTAKE_STATUS,
        replayed: false,
      } satisfies EvidenceIntakeResult
    })

    if (result.replayed) {
      await compensate(deps, input, object, 'EVIDENCE_REPLAYED')
    }
    return result
  } catch (error) {
    await compensate(deps, input, object, 'EVIDENCE_PERSISTENCE_FAILED')
    // Segunda barreira: se o índice parcial disparar (por exemplo, contra uma
    // escrita concorrente que não passou pelo lock), o domínio continua sendo
    // "já existe", não um 500 genérico.
    if (isDuplicateCustomerDocument(error)) {
      throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
    }
    if (error instanceof EvidenceIntakeError) throw error
    deps.logger.error(
      {
        tenant_id: input.tenantId,
        validation_id: input.validationId,
        artifact_id: object.artifactId,
        reason: 'EVIDENCE_PERSISTENCE_FAILED',
        error_name: errorNameOf(error),
        error_code: errorCodeOf(error),
      },
      'evidence persistence failed',
    )
    throw new EvidenceIntakeError(problems.evidencePersistenceFailed())
  }
}
