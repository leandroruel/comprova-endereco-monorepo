import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { ObjectStore } from '@comprova/providers'
import { randomUUID } from 'node:crypto'
import { evidenceWriteSchema, type EvidenceWriter } from './evidence.schema.js'

const DAY_MS = 86_400_000

/**
 * Materializa o artefato no object store e registra a linha em `evidence`.
 * Fronteira do módulo: valida o payload (schema) antes de persistir.
 */
export const makeEvidenceWriter =
  (db: Db, store: ObjectStore): EvidenceWriter =>
  async (rawEvidence) => {
    const evidence = evidenceWriteSchema.parse(rawEvidence)
    const evidenceId = randomUUID()
    const stored = await store.put(`evidence/${evidenceId}`, evidence.data, evidence.contentType)
    await db.insert(t.evidence).values({
      evidenceId,
      kind: evidence.kind,
      provider: evidence.provider,
      s3Uri: stored.uri,
      sha256: stored.sha256,
      capturedAt: evidence.capturedAt,
      retentionUntil: new Date(Date.now() + evidence.retentionDays * DAY_MS),
    })
    return evidenceId
  }
