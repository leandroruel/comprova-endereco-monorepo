import { and, eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of } from '@comprova/providers'
import type { ObjectStore } from '@comprova/providers'
import { randomUUID } from 'node:crypto'

/**
 * Fundação de artefatos de evidência (F0.1 / ADR-0035).
 *
 * Esta camada NÃO é um endpoint de upload: ela apenas grava o objeto bruto no
 * object storage existente e registra os metadados tenant-scoped. A extração,
 * o OCR e o vínculo com uma claim ficam para F1.
 *
 * Garantias:
 *   - o objeto é gravado sob `tenants/<tenant>/evidence/<artifact>`;
 *   - a linha só é criada dentro de `withTenant` (RLS WITH CHECK);
 *   - se o INSERT falhar, o objeto recém-gravado é removido (compensação);
 *   - o hash é calculado localmente e conferido contra o retorno do storage;
 *   - nenhuma URL pública/presigned é persistida — só `storage_key`.
 */

export const EVIDENCE_ARTIFACT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export type EvidenceArtifactContentType = (typeof EVIDENCE_ARTIFACT_CONTENT_TYPES)[number]

const CONTENT_TYPE_SET: ReadonlySet<string> = new Set(EVIDENCE_ARTIFACT_CONTENT_TYPES)

export interface EvidenceArtifactDeps {
  readonly db: Db
  readonly store: ObjectStore
}

export interface CreateEvidenceArtifactInput {
  readonly tenantId: string
  readonly claimEvidenceId: string
  readonly data: Uint8Array
  readonly contentType: string
  readonly retentionUntil: Date
}

export interface EvidenceArtifactMetadata {
  readonly artifactId: string
  readonly tenantId: string
  readonly claimEvidenceId: string
  readonly storageKey: string
  readonly contentType: EvidenceArtifactContentType
  readonly sizeBytes: number
  readonly sha256: Buffer
  readonly retentionUntil: Date
}

export const evidenceArtifactStorageKey = (tenantId: string, artifactId: string): string =>
  `tenants/${tenantId}/evidence/${artifactId}`

const normalizeContentType = (value: string): string => {
  const [base] = value.split(';')
  return (base ?? '').trim().toLowerCase()
}

const assertValidInput = (input: CreateEvidenceArtifactInput): EvidenceArtifactContentType => {
  if (input.tenantId.trim() === '') throw new Error('tenantId é obrigatório')
  if (input.claimEvidenceId.trim() === '') throw new Error('claimEvidenceId é obrigatório')
  if (input.data.byteLength === 0) throw new Error('artefato vazio')
  if (input.data.byteLength > t.EVIDENCE_ARTIFACT_MAX_BYTES) {
    throw new Error(`artefato excede o limite de ${t.EVIDENCE_ARTIFACT_MAX_BYTES} bytes`)
  }

  const contentType = normalizeContentType(input.contentType)
  if (!CONTENT_TYPE_SET.has(contentType)) {
    throw new Error(`content-type não suportado: ${input.contentType}`)
  }
  if (!(input.retentionUntil instanceof Date) || Number.isNaN(input.retentionUntil.getTime())) {
    throw new Error('retentionUntil inválido')
  }

  return contentType as EvidenceArtifactContentType
}

/**
 * Grava o objeto e registra o artefato. Ordem: storage primeiro, banco depois;
 * uma falha no banco dispara a compensação (delete do objeto). Não há
 * transação distribuída — o par (objeto, linha) é reconciliável por
 * `storage_key`.
 */
export const createEvidenceArtifact = async (
  deps: EvidenceArtifactDeps,
  input: CreateEvidenceArtifactInput,
): Promise<EvidenceArtifactMetadata> => {
  const contentType = assertValidInput(input)
  const artifactId = randomUUID()
  const storageKey = evidenceArtifactStorageKey(input.tenantId, artifactId)
  const sha256 = sha256Of(input.data)

  const stored = await deps.store.put(storageKey, input.data, contentType)
  if (stored.bytes !== input.data.byteLength || !stored.sha256.equals(sha256)) {
    await deps.store.delete(storageKey).catch(() => undefined)
    throw new Error('object storage devolveu metadados inconsistentes para o artefato')
  }

  try {
    await withTenant(deps.db, input.tenantId, (tx) =>
      tx.insert(t.evidenceArtifact).values({
        artifactId,
        tenantId: input.tenantId,
        claimEvidenceId: input.claimEvidenceId,
        storageKey,
        contentType,
        sizeBytes: input.data.byteLength,
        sha256,
        retentionUntil: input.retentionUntil,
      }),
    )
  } catch (error) {
    // A linha não existe; o objeto órfão não pode permanecer no storage.
    await deps.store.delete(storageKey).catch(() => undefined)
    throw error
  }

  return {
    artifactId,
    tenantId: input.tenantId,
    claimEvidenceId: input.claimEvidenceId,
    storageKey,
    contentType,
    sizeBytes: input.data.byteLength,
    sha256,
    retentionUntil: input.retentionUntil,
  }
}

/**
 * Remove o objeto físico e, só então, a linha. O objeto sai primeiro para nunca
 * deixar objeto órfão. Se o DELETE da linha falhar, a linha permanece como
 * marcador de retry; `store.delete` é idempotente e a próxima chamada conclui.
 * A ordem inversa deixaria um objeto órfão se o storage falhasse.
 */
export const deleteEvidenceArtifact = async (
  deps: EvidenceArtifactDeps,
  tenantId: string,
  artifactId: string,
): Promise<boolean> => {
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select({ storageKey: t.evidenceArtifact.storageKey })
      .from(t.evidenceArtifact)
      .where(and(eq(t.evidenceArtifact.tenantId, tenantId), eq(t.evidenceArtifact.artifactId, artifactId))),
  )

  const row = rows[0]
  if (row === undefined) return false

  await deps.store.delete(row.storageKey)

  const deleted = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .delete(t.evidenceArtifact)
      .where(and(eq(t.evidenceArtifact.tenantId, tenantId), eq(t.evidenceArtifact.artifactId, artifactId)))
      .returning({ artifactId: t.evidenceArtifact.artifactId }),
  )

  return deleted.length > 0
}
