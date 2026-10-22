import {
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createDbPool, eq, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { makeFakeObjectStore, sha256Of } from '@comprova/providers'
import type { ObjectStore } from '@comprova/providers'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createEvidenceArtifact,
  deleteEvidenceArtifact,
  evidenceArtifactStorageKey,
} from '../../src/services/evidence-artifact.js'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const appPool = createDbPool(db.appUrl)
const tenantA = await createTenant(adminPool.db, { name: 'artifact-tenant-a' })
const tenantB = await createTenant(adminPool.db, { name: 'artifact-tenant-b' })

afterAll(async () => {
  await appPool.end()
  await adminPool.end()
  await db.stop()
})

interface Observation {
  readonly claimEvidenceId: string
  readonly claimId: string
  readonly validationId: string
  readonly subjectId: string
}

const seedObservation = async (tenantId: string): Promise<Observation> => {
  const subjectId = await createSubject(adminPool.db, tenantId)
  const validationId = await createValidation(adminPool.db, tenantId, subjectId)
  const claimId = randomUUID()
  await adminPool.db.insert(t.claim).values({
    claimId,
    tenantId,
    validationId,
    subjectId,
    type: 'address_exists',
    subjectType: 'organization',
    targetType: 'address',
  })

  const claimEvidenceId = randomUUID()
  await adminPool.db.insert(t.claimEvidence).values({
    claimEvidenceId,
    tenantId,
    claimId,
    checker: 'document_integrity',
    checkerVersion: '1.0.0',
    stance: 'supports',
    strength: 0.5,
    confidence: 1,
    source: 'test',
    observedAt: new Date(),
    ttlSeconds: 3600,
    expiresAt: new Date(Date.now() + 86_400_000),
    detail: {},
  })

  return { claimEvidenceId, claimId, validationId, subjectId }
}

interface TrackingStore {
  readonly store: ObjectStore
  readonly puts: string[]
  readonly deletes: string[]
}

const trackingStore = (): TrackingStore => {
  const base = makeFakeObjectStore()
  const puts: string[] = []
  const deletes: string[] = []
  return {
    store: {
      put: async (key, data, contentType) => {
        puts.push(key)
        return base.put(key, data, contentType)
      },
      delete: async (key) => {
        deletes.push(key)
        await base.delete(key)
      },
    },
    puts,
    deletes,
  }
}

const artifactValues = (
  tenantId: string,
  claimEvidenceId: string,
  overrides: Partial<t.NewEvidenceArtifact> = {},
): t.NewEvidenceArtifact => {
  const artifactId = randomUUID()
  return {
    artifactId,
    tenantId,
    claimEvidenceId,
    storageKey: evidenceArtifactStorageKey(tenantId, artifactId),
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256: randomBytes(32),
    retentionUntil: new Date(Date.now() + 86_400_000),
    ...overrides,
  }
}

const insertArtifact = (tenantId: string, values: t.NewEvidenceArtifact): Promise<unknown> =>
  withTenant(appPool.db, tenantId, (tx) => tx.insert(t.evidenceArtifact).values(values))

const selectArtifact = (tenantId: string, artifactId: string) =>
  withTenant(appPool.db, tenantId, (tx) =>
    tx.select().from(t.evidenceArtifact).where(eq(t.evidenceArtifact.artifactId, artifactId)),
  )

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error ? `${error.message}\n${cause.message}` : error.message
}

const expectDbRejection = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(Error)
  expect(errorMessage(error)).toMatch(pattern)
}

describe('evidence_artifact: isolamento RLS', () => {
  it('tenant A cria/lê o próprio artefato; tenant B não vê', async () => {
    const obsA = await seedObservation(tenantA)
    const values = artifactValues(tenantA, obsA.claimEvidenceId)

    await insertArtifact(tenantA, values)

    const asA = await selectArtifact(tenantA, values.artifactId)
    expect(asA).toHaveLength(1)

    const asB = await selectArtifact(tenantB, values.artifactId)
    expect(asB).toHaveLength(0)
  })

  it('tenant B não altera artefato de A (sem grant de UPDATE e trigger de imutabilidade)', async () => {
    const obsA = await seedObservation(tenantA)
    const values = artifactValues(tenantA, obsA.claimEvidenceId)
    await insertArtifact(tenantA, values)

    await expectDbRejection(
      withTenant(appPool.db, tenantB, (tx) =>
        tx
          .update(t.evidenceArtifact)
          .set({ contentType: 'image/png' })
          .where(eq(t.evidenceArtifact.artifactId, values.artifactId)),
      ),
      /permission denied/i,
    )

    // Nem o admin/owner reescreve o artefato bruto.
    await expectDbRejection(
      adminPool.db
        .update(t.evidenceArtifact)
        .set({ contentType: 'image/png' })
        .where(eq(t.evidenceArtifact.artifactId, values.artifactId)),
      /imutável/i,
    )
  })

  it('tenant B não exclui artefato de A', async () => {
    const obsA = await seedObservation(tenantA)
    const values = artifactValues(tenantA, obsA.claimEvidenceId)
    await insertArtifact(tenantA, values)

    const deleted = await withTenant(appPool.db, tenantB, (tx) =>
      tx
        .delete(t.evidenceArtifact)
        .where(eq(t.evidenceArtifact.artifactId, values.artifactId))
        .returning({ artifactId: t.evidenceArtifact.artifactId }),
    )
    expect(deleted).toHaveLength(0)

    expect(await selectArtifact(tenantA, values.artifactId)).toHaveLength(1)
  })

  it('tenant B não insere linha com tenant_id de A', async () => {
    const obsA = await seedObservation(tenantA)
    const values = artifactValues(tenantA, obsA.claimEvidenceId)

    await expectDbRejection(insertArtifact(tenantB, values), /row-level security|violates/i)
  })

  it('sem contexto de tenant, SELECT não vê nada e INSERT é bloqueado', async () => {
    const obsA = await seedObservation(tenantA)
    const values = artifactValues(tenantA, obsA.claimEvidenceId)
    await insertArtifact(tenantA, values)

    const rows = await appPool.db.select().from(t.evidenceArtifact)
    expect(rows).toHaveLength(0)

    await expectDbRejection(
      appPool.db.insert(t.evidenceArtifact).values(values),
      /row-level security|violates/i,
    )
  })
})

describe('evidence_artifact: integridade', () => {
  it('FK composta impede associar artefato do tenant A a observação do tenant B', async () => {
    const obsB = await seedObservation(tenantB)
    const values = artifactValues(tenantA, obsB.claimEvidenceId)

    await expectDbRejection(insertArtifact(tenantA, values), /foreign key|violates/i)
  })

  it('checks de tamanho, hash e content-type são aplicados pelo PostgreSQL', async () => {
    const obsA = await seedObservation(tenantA)

    await expectDbRejection(
      insertArtifact(tenantA, artifactValues(tenantA, obsA.claimEvidenceId, { sizeBytes: 0 })),
      /check constraint|violates/i,
    )

    await expectDbRejection(
      insertArtifact(tenantA, artifactValues(tenantA, obsA.claimEvidenceId, { sizeBytes: 52_428_801 })),
      /check constraint|violates/i,
    )

    await expectDbRejection(
      insertArtifact(tenantA, artifactValues(tenantA, obsA.claimEvidenceId, { sha256: randomBytes(31) })),
      /check constraint|violates/i,
    )

    await expectDbRejection(
      insertArtifact(tenantA, artifactValues(tenantA, obsA.claimEvidenceId, { contentType: '' })),
      /check constraint|violates/i,
    )
  })

  it('storage_key precisa estar no namespace do próprio tenant', async () => {
    const obsA = await seedObservation(tenantA)
    const values = artifactValues(tenantA, obsA.claimEvidenceId, {
      storageKey: `tenants/${tenantB}/evidence/${randomUUID()}`,
    })

    await expectDbRejection(insertArtifact(tenantA, values), /check constraint|violates/i)
  })

  it('storage_key é único por tenant', async () => {
    const obsA = await seedObservation(tenantA)
    const first = artifactValues(tenantA, obsA.claimEvidenceId)
    await insertArtifact(tenantA, first)

    const second = artifactValues(tenantA, obsA.claimEvidenceId, {
      storageKey: first.storageKey,
    })
    await expectDbRejection(insertArtifact(tenantA, second), /duplicate key|unique/i)
  })

  it('persiste metadados e hash calculado localmente', async () => {
    const obsA = await seedObservation(tenantA)
    const payload = Buffer.from('%PDF-1.7\ncomprovante de endereco\n')
    const retentionUntil = new Date(Date.now() + 30 * 86_400_000)
    const tracking = trackingStore()

    const metadata = await createEvidenceArtifact(
      { db: appPool.db, store: tracking.store },
      {
        tenantId: tenantA,
        claimEvidenceId: obsA.claimEvidenceId,
        data: payload,
        contentType: 'application/pdf; charset=binary',
        retentionUntil,
      },
    )

    expect(metadata.contentType).toBe('application/pdf')
    expect(metadata.sizeBytes).toBe(payload.byteLength)
    expect(metadata.sha256).toEqual(sha256Of(payload))
    expect(metadata.storageKey).toBe(evidenceArtifactStorageKey(tenantA, metadata.artifactId))
    expect(tracking.puts).toContain(metadata.storageKey)

    const [row] = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.artifactId, metadata.artifactId))
    expect(row).toBeDefined()
    expect(row?.tenantId).toBe(tenantA)
    expect(row?.claimEvidenceId).toBe(obsA.claimEvidenceId)
    expect(row?.storageKey).toBe(metadata.storageKey)
    expect(row?.contentType).toBe('application/pdf')
    expect(row?.sizeBytes).toBe(payload.byteLength)
    expect(row?.sha256).toEqual(sha256Of(payload))
    expect(row?.retentionUntil).toEqual(retentionUntil)
  })
})

describe('evidence_artifact: serviço e lifecycle', () => {
  it('rejeita content-type fora da allowlist e artefato vazio sem tocar no storage', async () => {
    const obsA = await seedObservation(tenantA)
    const tracking = trackingStore()

    await expect(
      createEvidenceArtifact(
        { db: appPool.db, store: tracking.store },
        {
          tenantId: tenantA,
          claimEvidenceId: obsA.claimEvidenceId,
          data: new Uint8Array([1]),
          contentType: 'text/plain',
          retentionUntil: new Date(Date.now() + 86_400_000),
        },
      ),
    ).rejects.toThrow(/content-type/)

    await expect(
      createEvidenceArtifact(
        { db: appPool.db, store: tracking.store },
        {
          tenantId: tenantA,
          claimEvidenceId: obsA.claimEvidenceId,
          data: new Uint8Array(0),
          contentType: 'application/pdf',
          retentionUntil: new Date(Date.now() + 86_400_000),
        },
      ),
    ).rejects.toThrow(/vazio/)

    expect(tracking.puts).toHaveLength(0)
  })

  it('compensa o storage quando o vínculo cross-tenant falha no FK', async () => {
    const obsB = await seedObservation(tenantB)
    const tracking = trackingStore()

    await expectDbRejection(
      createEvidenceArtifact(
        { db: appPool.db, store: tracking.store },
        {
          tenantId: tenantA,
          claimEvidenceId: obsB.claimEvidenceId,
          data: Buffer.from('%PDF-1.7\n'),
          contentType: 'application/pdf',
          retentionUntil: new Date(Date.now() + 86_400_000),
        },
      ),
      /foreign key|violates/i,
    )

    expect(tracking.puts).toHaveLength(1)
    expect(tracking.deletes).toHaveLength(1)
    expect(tracking.deletes[0]?.startsWith(`tenants/${tenantA}/evidence/`)).toBe(true)
    const leaked = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.claimEvidenceId, obsB.claimEvidenceId))
    expect(leaked).toHaveLength(0)
  })

  it('compensa o storage quando ele devolve hash inconsistente', async () => {
    const obsA = await seedObservation(tenantA)
    const deletes: string[] = []
    const store: ObjectStore = {
      put: async (key, data) => ({
        key,
        uri: `memory://${key}`,
        sha256: randomBytes(32),
        bytes: data.byteLength,
      }),
      delete: async (key) => {
        deletes.push(key)
      },
    }

    await expect(
      createEvidenceArtifact(
        { db: appPool.db, store },
        {
          tenantId: tenantA,
          claimEvidenceId: obsA.claimEvidenceId,
          data: Buffer.from('%PDF-1.7\n'),
          contentType: 'application/pdf',
          retentionUntil: new Date(Date.now() + 86_400_000),
        },
      ),
    ).rejects.toThrow(/inconsistentes/)

    expect(deletes).toHaveLength(1)
  })

  it('deleteEvidenceArtifact remove objeto e linha; outro tenant não remove', async () => {
    const obsA = await seedObservation(tenantA)
    const tracking = trackingStore()
    const metadata = await createEvidenceArtifact(
      { db: appPool.db, store: tracking.store },
      {
        tenantId: tenantA,
        claimEvidenceId: obsA.claimEvidenceId,
        data: Buffer.from('%PDF-1.7\n'),
        contentType: 'application/pdf',
        retentionUntil: new Date(Date.now() + 86_400_000),
      },
    )

    // Tenant B não encontra a linha para remover.
    expect(
      await deleteEvidenceArtifact({ db: appPool.db, store: tracking.store }, tenantB, metadata.artifactId),
    ).toBe(false)
    expect(await selectArtifact(tenantA, metadata.artifactId)).toHaveLength(1)

    expect(
      await deleteEvidenceArtifact({ db: appPool.db, store: tracking.store }, tenantA, metadata.artifactId),
    ).toBe(true)
    expect(tracking.deletes).toContain(metadata.storageKey)
    expect(await selectArtifact(tenantA, metadata.artifactId)).toHaveLength(0)
  })

  it('deleteEvidenceArtifact deixa a linha como marcador de retry quando o DELETE falha', async () => {
    const obsA = await seedObservation(tenantA)
    const tracking = trackingStore()
    const metadata = await createEvidenceArtifact(
      { db: appPool.db, store: tracking.store },
      {
        tenantId: tenantA,
        claimEvidenceId: obsA.claimEvidenceId,
        data: Buffer.from('%PDF-1.7\n'),
        contentType: 'application/pdf',
        retentionUntil: new Date(Date.now() + 86_400_000),
      },
    )

    let transactions = 0
    const failingDb = new Proxy(appPool.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (...args: Parameters<typeof target.transaction>) => {
            transactions += 1
            if (transactions === 2) throw new Error('db delete failed')
            return target.transaction(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    await expect(
      deleteEvidenceArtifact({ db: failingDb, store: tracking.store }, tenantA, metadata.artifactId),
    ).rejects.toThrow('db delete failed')

    // O objeto saiu, mas a linha permanece como marcador para o próximo retry.
    expect(tracking.deletes).toContain(metadata.storageKey)
    expect(await selectArtifact(tenantA, metadata.artifactId)).toHaveLength(1)

    // O retry com o banco recuperado conclui a remoção; o delete é idempotente.
    expect(
      await deleteEvidenceArtifact({ db: appPool.db, store: tracking.store }, tenantA, metadata.artifactId),
    ).toBe(true)
    expect(await selectArtifact(tenantA, metadata.artifactId)).toHaveLength(0)
  })

  it('claim_evidence com artefato não pode ser removida (RESTRICT); após remover o artefato, pode', async () => {
    const obsA = await seedObservation(tenantA)
    const tracking = trackingStore()
    const metadata = await createEvidenceArtifact(
      { db: appPool.db, store: tracking.store },
      {
        tenantId: tenantA,
        claimEvidenceId: obsA.claimEvidenceId,
        data: Buffer.from('%PDF-1.7\n'),
        contentType: 'application/pdf',
        retentionUntil: new Date(Date.now() + 86_400_000),
      },
    )

    await expectDbRejection(
      withTenant(appPool.db, tenantA, (tx) =>
        tx.delete(t.claimEvidence).where(eq(t.claimEvidence.claimEvidenceId, obsA.claimEvidenceId)),
      ),
      /foreign key|violates/i,
    )

    await deleteEvidenceArtifact({ db: appPool.db, store: tracking.store }, tenantA, metadata.artifactId)

    const deleted = await withTenant(appPool.db, tenantA, (tx) =>
      tx
        .delete(t.claimEvidence)
        .where(eq(t.claimEvidence.claimEvidenceId, obsA.claimEvidenceId))
        .returning({ claimEvidenceId: t.claimEvidence.claimEvidenceId }),
    )
    expect(deleted).toHaveLength(1)
  })
})
