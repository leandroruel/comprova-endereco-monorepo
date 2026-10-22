import { problem, problems, type Problem } from '@comprova/contracts'
import { and, eq, withTenant } from '@comprova/db'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { sha256Of } from '@comprova/providers'
import type { ObjectStore } from '@comprova/providers'
import { createHash, randomUUID } from 'node:crypto'
import {
  insertEvidenceArtifact,
  storeEvidenceObject,
  type StoredEvidenceObject,
} from '../../services/evidence-artifact.js'

/**
 * F1.1 — intake seguro do comprovante.
 *
 * O upload NÃO afirma que o documento é autêntico nem que o endereço/titular
 * correspondem. Ele cria uma observação `unknown`/`pending` em `claim_evidence`
 * (`source = customer_submitted_document`) e o artefato físico tenant-scoped.
 * A análise/verificação é F1.2/F1.3.
 */

export const EVIDENCE_INTAKE_SOURCE = 'customer_submitted_document'
export const EVIDENCE_INTAKE_CHECKER = 'customer_document_intake'
export const EVIDENCE_INTAKE_CHECKER_VERSION = '1.0.0'
export const EVIDENCE_INTAKE_STATUS = 'pending'

export const EVIDENCE_INTAKE_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const

export type EvidenceIntakeContentType = (typeof EVIDENCE_INTAKE_CONTENT_TYPES)[number]

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

const normalizeDeclaredContentType = (value: string | undefined): string | null => {
  if (value === undefined) return null
  const [base] = value.split(';')
  const normalized = (base ?? '').trim().toLowerCase()
  if (normalized === 'image/jpg') return 'image/jpeg'
  return normalized
}

const startsWith = (data: Uint8Array, signature: readonly number[]): boolean =>
  data.byteLength >= signature.length && signature.every((byte, index) => data[index] === byte)

/**
 * Sniffing dos formatos aceitos. Não confia em filename, extensão ou no
 * `Content-Type` declarado: o tipo persistido é sempre o detectado aqui.
 */
export const detectEvidenceIntakeContentType = (data: Uint8Array): EvidenceIntakeContentType | null => {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg' // SOI + marker
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return null
}

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
  return rows[0]
}

const loadClaimId = async (tx: DbTx, validationId: string): Promise<string | undefined> => {
  const rows = await tx
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
    .limit(1)
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

const replayOf = (existing: ExistingEvidence): EvidenceIntakeResult => {
  if (existing.artifactId === null) throw persistenceFailed()
  return {
    evidenceId: existing.claimEvidenceId,
    artifactId: existing.artifactId,
    status: EVIDENCE_INTAKE_STATUS,
    replayed: true,
  }
}

const ensureClaim = async (tx: DbTx, validation: IntakeValidation): Promise<string> => {
  const existing = await loadClaimId(tx, validation.validationId)
  if (existing !== undefined) return existing

  const subjectRows = await tx
    .select({ docType: t.subject.docType })
    .from(t.subject)
    .where(eq(t.subject.subjectId, validation.subjectId))
    .limit(1)
  const docType = subjectRows[0]?.docType
  if (docType === undefined) throw new Error('validation subject missing')

  const type = docType === 'CNPJ' ? 'business_registered_address' : 'address_exists'
  const subjectType = docType === 'CNPJ' ? 'organization' : 'person'
  await tx
    .insert(t.claim)
    .values({
      claimId: randomUUID(),
      tenantId: validation.tenantId,
      validationId: validation.validationId,
      subjectId: validation.subjectId,
      addressId: validation.addressId,
      type,
      subjectType,
      targetType: 'address',
    })
    .onConflictDoNothing()

  const claimId = await loadClaimId(tx, validation.validationId)
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

    const claimId = await loadClaimId(tx, input.validationId)
    if (claimId === undefined) {
      if (marker !== undefined) throw persistenceFailed()
      return { kind: 'upload' as const }
    }

    const existing = await loadExistingEvidence(tx, claimId)
    if (marker !== undefined) {
      if (existing === undefined || !matches(existing, contentType, sha256)) {
        throw persistenceFailed()
      }
      return { kind: 'replay' as const, result: replayOf(existing) }
    }
    if (existing === undefined) return { kind: 'upload' as const }
    if (matches(existing, contentType, sha256)) {
      // Replay por conteúdo com uma key nova: registra o alias para que um
      // reuso dessa key com outro conteúdo seja detectado como mismatch.
      await recordIdempotency(tx, input, requestHash)
      return { kind: 'replay' as const, result: replayOf(existing) }
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

const isDuplicateCustomerDocument = (error: unknown): boolean =>
  errorCodeOf(error) === '23505' && errorConstraintOf(error) === 'idx_claim_evidence_customer_document_uq'

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

      const existing = await loadExistingEvidence(tx, claimId)
      if (marker !== undefined) {
        if (existing === undefined || !matches(existing, contentType, sha256)) {
          throw persistenceFailed()
        }
        return replayOf(existing)
      }
      if (existing !== undefined) {
        if (!matches(existing, contentType, sha256)) {
          throw new EvidenceIntakeError(problems.evidenceAlreadyExists())
        }
        await recordIdempotency(tx, input, requestHash)
        return replayOf(existing)
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
        // O upload só prova que um documento foi apresentado. Não há stance
        // de endereço/titular até F1.2/F1.3; `confidence` é NOT NULL, então o
        // valor neutro 0 expressa ausência de avaliação, não negação.
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

      await insertEvidenceArtifact(tx, {
        tenantId: input.tenantId,
        claimEvidenceId,
        object,
        retentionUntil: validation.expiresAt,
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
