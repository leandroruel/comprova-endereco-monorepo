import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, inArray, runMigrations, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of, type ObjectStore, type StoredObject } from '@comprova/providers'
import {
  createApiKey,
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { validationRetentionTick } from '../../worker/src/modules/retention/retention.service.js'
import { buildApp } from '../src/app.js'
import { API_SCOPES } from '../src/plugins/scope.js'

const PEPPER = 'test-pepper-evidence-intake'
const MAX_BYTES = 1024

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

class TestObjectStore implements ObjectStore {
  readonly objects = new Map<string, { readonly data: Buffer; readonly contentType: string }>()
  readonly puts: string[] = []
  readonly deletes: string[] = []
  failPut: Error | null = null
  failDelete: Error | null = null
  putGate: Promise<void> | null = null
  activePuts = 0
  maxActivePuts = 0

  async put(key: string, data: Uint8Array, contentType: string): Promise<StoredObject> {
    if (this.failPut !== null) throw this.failPut
    this.activePuts += 1
    this.maxActivePuts = Math.max(this.maxActivePuts, this.activePuts)
    try {
      if (this.putGate !== null) await this.putGate
      const bytes = Buffer.from(data)
      this.puts.push(key)
      this.objects.set(key, { data: bytes, contentType })
      return { key, uri: `test://${key}`, sha256: sha256Of(data), bytes: data.byteLength }
    } finally {
      this.activePuts -= 1
    }
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete !== null) throw this.failDelete
    this.deletes.push(key)
    this.objects.delete(key)
  }
}

const store = new TestObjectStore()
const logLines: string[] = []
const logger = createLogger({
  level: 'debug',
  stream: { write: (line) => logLines.push(line) },
})

const tenantA = await createTenant(adminPool.db, { name: 'evidence-a' })
const tenantB = await createTenant(adminPool.db, { name: 'evidence-b' })
const tenantClaimFail = await createTenant(adminPool.db, { name: 'evidence-claim-fail' })
const tenantArtifactFail = await createTenant(adminPool.db, { name: 'evidence-artifact-fail' })

const keyA = (await createApiKey(adminPool.db, tenantA, PEPPER)).plaintext
const readOnlyKey = (await createApiKey(adminPool.db, tenantA, PEPPER, { scopes: [API_SCOPES.validateRead] }))
  .plaintext
const keyClaimFail = (await createApiKey(adminPool.db, tenantClaimFail, PEPPER)).plaintext
const keyArtifactFail = (await createApiKey(adminPool.db, tenantArtifactFail, PEPPER)).plaintext

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: '[]',
    SIGNING_KEY_PROVIDER: 'local',
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'debug',
    POLICY_VERSION: '2026.11.1',
    TEMPORAL_ENABLED: false,
    VLM_ENABLED: false,
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'comprova-deep-t1',
    WORKER_LOOPS: false,
    EVIDENCE_MAX_BYTES: MAX_BYTES,
    EVIDENCE_MAX_CONCURRENCY: 2,
  },
  db: appPool.db,
  redis,
  logger,
  metrics: createMetrics(),
  objectStore: store,
})

const installFailureTriggers = async (): Promise<void> => {
  await adminPool.db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_claim_evidence() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id = '${tenantClaimFail}'::uuid THEN
          RAISE EXCEPTION 'test claim evidence failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `),
  )
  await adminPool.db.execute(
    sql.raw(`
      CREATE TRIGGER test_fail_claim_evidence_trg
      BEFORE INSERT ON claim_evidence
      FOR EACH ROW EXECUTE FUNCTION test_fail_claim_evidence();
    `),
  )
  await adminPool.db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_evidence_artifact() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id = '${tenantArtifactFail}'::uuid THEN
          RAISE EXCEPTION 'test evidence artifact failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `),
  )
  await adminPool.db.execute(
    sql.raw(`
      CREATE TRIGGER test_fail_evidence_artifact_trg
      BEFORE INSERT ON evidence_artifact
      FOR EACH ROW EXECUTE FUNCTION test_fail_evidence_artifact();
    `),
  )
}

await installFailureTriggers()

afterAll(async () => {
  await app.close()
  await adminPool.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_fail_claim_evidence_trg ON claim_evidence'))
  await adminPool.db.execute(
    sql.raw('DROP TRIGGER IF EXISTS test_fail_evidence_artifact_trg ON evidence_artifact'),
  )
  await adminPool.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_fail_claim_evidence()'))
  await adminPool.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_fail_evidence_artifact()'))
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

const makeValidation = async (tenantId: string): Promise<string> => {
  const subjectId = await createSubject(adminPool.db, tenantId)
  return createValidation(adminPool.db, tenantId, subjectId)
}

const auth = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` })

interface MultipartFileInput {
  readonly data: Buffer
  readonly filename?: string
  readonly contentType?: string
}

const multipart = (
  file: MultipartFileInput,
): { readonly payload: Buffer; readonly headers: Record<string, string> } => {
  const boundary = `----comprova-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename ?? 'proof.pdf'}"\r\nContent-Type: ${file.contentType ?? 'application/pdf'}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, file.data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const emptyMultipart = (): { readonly payload: Buffer; readonly headers: Record<string, string> } => {
  const boundary = `----comprova-${randomUUID()}`
  return {
    payload: Buffer.from(`--${boundary}--\r\n`),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const fieldMultipart = (
  field: string,
  value: string,
): { readonly payload: Buffer; readonly headers: Record<string, string> } => {
  const boundary = `----comprova-${randomUUID()}`
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n--${boundary}--\r\n`,
  )
  return {
    payload: body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const twoFilesMultipart = (): {
  readonly payload: Buffer
  readonly headers: Record<string, string>
} => {
  const boundary = `----comprova-${randomUUID()}`
  const filePart = (filename: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    )
  return {
    payload: Buffer.concat([
      filePart('one.pdf'),
      pdf,
      Buffer.from(`\r\n`),
      filePart('two.pdf'),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const truncatedMultipart = (): {
  readonly payload: Buffer
  readonly headers: Record<string, string>
} => {
  const boundary = `----comprova-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="truncated.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
  )
  return {
    // Falta o fechamento `--boundary--`; o busboy deve rejeitar como malformado.
    payload: Buffer.concat([head, pdf]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

interface UploadOptions {
  readonly key?: string
  readonly idempotencyKey?: string
}

const upload = async (validationId: string, file: MultipartFileInput, options: UploadOptions = {}) => {
  const body = multipart(file)
  return app.inject({
    method: 'POST',
    url: `/v1/validations/${validationId}/evidence`,
    headers: {
      ...auth(options.key ?? keyA),
      ...body.headers,
      ...(options.idempotencyKey !== undefined ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
    payload: body.payload,
  })
}

const expectProblem = (response: Awaited<ReturnType<typeof upload>>, status: number, code: string): void => {
  expect(response.statusCode).toBe(status)
  expect(response.headers['content-type']).toContain('application/problem+json')
  expect(response.json()).toMatchObject({ status, code })
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Graph {
  readonly claims: {
    readonly claimId: string
    readonly type: string
    readonly subjectType: string
  }[]
  readonly evidence: (typeof t.claimEvidence.$inferSelect)[]
  readonly artifacts: (typeof t.evidenceArtifact.$inferSelect)[]
}

const graphOf = async (validationId: string): Promise<Graph> => {
  const claims = await adminPool.db
    .select({
      claimId: t.claim.claimId,
      type: t.claim.type,
      subjectType: t.claim.subjectType,
    })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  const claimId = claims[0]?.claimId
  if (claimId === undefined) return { claims, evidence: [], artifacts: [] }
  const evidence = await adminPool.db
    .select()
    .from(t.claimEvidence)
    .where(eq(t.claimEvidence.claimId, claimId))
  if (evidence.length === 0) return { claims, evidence, artifacts: [] }
  const artifacts = await adminPool.db
    .select()
    .from(t.evidenceArtifact)
    .where(
      inArray(
        t.evidenceArtifact.claimEvidenceId,
        evidence.map((row) => row.claimEvidenceId),
      ),
    )
  return { claims, evidence, artifacts }
}

describe('POST /v1/validations/:id/evidence', () => {
  it('aceita PDF, cria claim/claim_evidence/artifact e não devolve storage path', async () => {
    const validationId = await makeValidation(tenantA)
    const validationRows = await adminPool.db
      .select({ expiresAt: t.validation.expiresAt })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    const expiresAt = validationRows[0]?.expiresAt
    if (expiresAt === undefined) throw new Error('validation missing')

    const res = await upload(validationId, { data: pdf })
    expect(res.statusCode).toBe(201)
    expect(res.headers['idempotent-replayed']).toBeUndefined()
    const body = res.json() as {
      evidence_id: string
      artifact_id: string
      status: string
    }
    expect(body.status).toBe('pending')
    expect(body.evidence_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.artifact_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Object.keys(body).sort()).toEqual(['artifact_id', 'evidence_id', 'status'])
    expect(res.body).not.toContain('tenants/')
    expect(res.body).not.toContain('proof.pdf')

    const graph = await graphOf(validationId)
    expect(graph.claims).toHaveLength(1)
    expect(graph.claims[0]).toMatchObject({
      type: 'business_registered_address',
      subjectType: 'organization',
    })
    expect(graph.evidence).toHaveLength(1)
    expect(graph.artifacts).toHaveLength(1)

    const evidence = graph.evidence[0]
    const artifact = graph.artifacts[0]
    if (evidence === undefined || artifact === undefined) throw new Error('graph missing')

    expect(evidence.claimEvidenceId).toBe(body.evidence_id)
    expect(evidence.source).toBe('customer_submitted_document')
    expect(evidence.checker).toBe('customer_document_intake')
    expect(evidence.checkerVersion).toBe('1.0.0')
    expect(evidence.stance).toBe('unknown')
    expect(evidence.strength).toBe(0)
    expect(evidence.confidence).toBe(1)
    expect(evidence.evidenceId).toBeNull()
    expect(evidence.evidenceSha256?.equals(sha256Of(pdf))).toBe(true)
    expect(evidence.detail).toMatchObject({
      verification: {
        status: 'pending',
        method: 'content_intake',
        document: null,
        address: null,
        holder: null,
      },
      artifact: { content_type: 'application/pdf', size_bytes: pdf.byteLength },
    })
    expect(evidence.expiresAt.getTime()).toBe(expiresAt.getTime())

    expect(artifact.artifactId).toBe(body.artifact_id)
    expect(artifact.storageKey).toBe(`tenants/${tenantA}/evidence/${artifact.artifactId}`)
    expect(artifact.contentType).toBe('application/pdf')
    expect(artifact.sizeBytes).toBe(pdf.byteLength)
    expect(artifact.sha256.equals(sha256Of(pdf))).toBe(true)
    expect(artifact.retentionUntil.getTime()).toBe(expiresAt.getTime())
    expect(store.objects.get(artifact.storageKey)?.data.equals(pdf)).toBe(true)

    const get = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationId}`,
      headers: auth(keyA),
    })
    expect(get.statusCode).toBe(200)
    expect(get.json().evidence_summary.unknown).toBe(1)
  })

  it('aceita JPEG e PNG e não usa o filename para o storage key', async () => {
    const jpegValidation = await makeValidation(tenantA)
    const jpegRes = await upload(jpegValidation, {
      data: jpeg,
      filename: '../../evil.jpeg',
      contentType: 'image/jpeg',
    })
    expect(jpegRes.statusCode).toBe(201)
    const jpegGraph = await graphOf(jpegValidation)
    const jpegArtifact = jpegGraph.artifacts[0]
    if (jpegArtifact === undefined) throw new Error('jpeg artifact missing')
    expect(jpegArtifact.contentType).toBe('image/jpeg')
    expect(jpegArtifact.storageKey).toBe(`tenants/${tenantA}/evidence/${jpegArtifact.artifactId}`)
    expect(jpegArtifact.storageKey).not.toContain('evil')
    expect(jpegArtifact.storageKey).not.toContain('..')

    const pngValidation = await makeValidation(tenantA)
    const pngRes = await upload(pngValidation, { data: png, contentType: 'image/png' })
    expect(pngRes.statusCode).toBe(201)
    const pngGraph = await graphOf(pngValidation)
    expect(pngGraph.artifacts[0]?.contentType).toBe('image/png')
  })

  it('rejeita spoofing de MIME, tipo não suportado e conteúdo vazio', async () => {
    const mismatchValidation = await makeValidation(tenantA)
    expectProblem(
      await upload(mismatchValidation, { data: pdf, contentType: 'image/png' }),
      422,
      'EVIDENCE_CONTENT_MISMATCH',
    )

    const unsupportedValidation = await makeValidation(tenantA)
    expectProblem(
      await upload(unsupportedValidation, { data: pdf, contentType: 'text/plain' }),
      415,
      'UNSUPPORTED_EVIDENCE_TYPE',
    )

    const invalidMagicValidation = await makeValidation(tenantA)
    expectProblem(
      await upload(invalidMagicValidation, {
        data: Buffer.from('not a document'),
        contentType: 'application/pdf',
      }),
      415,
      'UNSUPPORTED_EVIDENCE_TYPE',
    )

    const emptyValidation = await makeValidation(tenantA)
    expectProblem(await upload(emptyValidation, { data: Buffer.alloc(0) }), 422, 'EVIDENCE_EMPTY')
  })

  it('aceita Content-Type genérico quando o conteúdo é detectável', async () => {
    const validationId = await makeValidation(tenantA)
    const res = await upload(validationId, {
      data: pdf,
      contentType: 'application/octet-stream',
    })
    expect(res.statusCode).toBe(201)
    const graph = await graphOf(validationId)
    expect(graph.artifacts[0]?.contentType).toBe('application/pdf')
  })

  it('rejeita arquivo ausente, multipart inválido, campo tenant_id e excesso de tamanho', async () => {
    const validationId = await makeValidation(tenantA)

    const missing = emptyMultipart()
    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: { ...auth(keyA), ...missing.headers },
        payload: missing.payload,
      }),
      400,
      'EVIDENCE_FILE_REQUIRED',
    )

    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: { ...auth(keyA), 'content-type': 'application/json' },
        payload: { tenant_id: tenantB },
      }),
      400,
      'INVALID_MULTIPART',
    )

    const field = fieldMultipart('tenant_id', tenantB)
    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: { ...auth(keyA), ...field.headers },
        payload: field.payload,
      }),
      400,
      'INVALID_MULTIPART',
    )

    const twoFiles = twoFilesMultipart()
    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: { ...auth(keyA), ...twoFiles.headers },
        payload: twoFiles.payload,
      }),
      400,
      'INVALID_MULTIPART',
    )

    const truncated = truncatedMultipart()
    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: { ...auth(keyA), ...truncated.headers },
        payload: truncated.payload,
      }),
      400,
      'INVALID_MULTIPART',
    )

    expectProblem(
      await upload(validationId, {
        data: Buffer.alloc(MAX_BYTES + 1, 0x41),
        contentType: 'application/pdf',
      }),
      413,
      'EVIDENCE_TOO_LARGE',
    )
  })

  it('exige write scope e esconde validation de outro tenant com 404', async () => {
    const validationId = await makeValidation(tenantA)
    const body = multipart({ data: pdf })

    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: body.headers,
        payload: body.payload,
      }),
      401,
      'UNAUTHORIZED',
    )

    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/v1/validations/${validationId}/evidence`,
        headers: { ...auth(readOnlyKey), ...body.headers },
        payload: body.payload,
      }),
      403,
      'FORBIDDEN',
    )

    const foreignValidation = await makeValidation(tenantB)
    const putsBefore = store.puts.length
    expectProblem(await upload(foreignValidation, { data: pdf }), 404, 'NOT_FOUND')
    expect(store.puts.length).toBe(putsBefore)
  })

  it('é idempotente por conteúdo e por Idempotency-Key', async () => {
    const validationId = await makeValidation(tenantA)
    const idempotencyKey = 'evidence-idem-key-0001'

    const first = await upload(validationId, { data: pdf }, { idempotencyKey })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json() as { evidence_id: string; artifact_id: string }
    const putsAfterFirst = store.puts.length

    const replay = await upload(validationId, { data: pdf }, { idempotencyKey })
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.json()).toMatchObject(firstBody)
    expect(store.puts.length).toBe(putsAfterFirst)

    const replayWithoutKey = await upload(validationId, { data: pdf })
    expect(replayWithoutKey.statusCode).toBe(200)
    expect(replayWithoutKey.json()).toMatchObject(firstBody)
    expect(store.puts.length).toBe(putsAfterFirst)

    const aliasKey = 'evidence-idem-key-0002'
    const aliasReplay = await upload(validationId, { data: pdf }, { idempotencyKey: aliasKey })
    expect(aliasReplay.statusCode).toBe(200)
    expect(aliasReplay.json()).toMatchObject(firstBody)
    expect(store.puts.length).toBe(putsAfterFirst)
    expectProblem(
      await upload(validationId, { data: jpeg, contentType: 'image/jpeg' }, { idempotencyKey: aliasKey }),
      422,
      'IDEMPOTENCY_MISMATCH',
    )

    const different = await upload(validationId, { data: jpeg, contentType: 'image/jpeg' })
    expectProblem(different, 409, 'EVIDENCE_ALREADY_EXISTS')
    expect(store.puts.length).toBe(putsAfterFirst)

    const keyMismatch = await upload(
      validationId,
      { data: jpeg, contentType: 'image/jpeg' },
      { idempotencyKey },
    )
    expectProblem(keyMismatch, 422, 'IDEMPOTENCY_MISMATCH')
    expect(store.puts.length).toBe(putsAfterFirst)

    const graph = await graphOf(validationId)
    expect(graph.evidence).toHaveLength(1)
    expect(graph.artifacts).toHaveLength(1)
  })

  it('serializa uploads concorrentes e mantém uma única evidência', async () => {
    const validationId = await makeValidation(tenantA)
    const [first, second] = await Promise.all([
      upload(validationId, { data: pdf }),
      upload(validationId, { data: pdf }),
    ])

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201])
    const graph = await graphOf(validationId)
    expect(graph.evidence).toHaveLength(1)
    expect(graph.artifacts).toHaveLength(1)
    const artifact = graph.artifacts[0]
    if (artifact === undefined) throw new Error('artifact missing')
    expect(store.objects.has(artifact.storageKey)).toBe(true)
  })

  it('limita uploads em voo antes de bufferizar o arquivo', async () => {
    const validations = await Promise.all([
      makeValidation(tenantA),
      makeValidation(tenantA),
      makeValidation(tenantA),
    ])
    let releaseGate: (() => void) | undefined
    store.putGate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    store.activePuts = 0
    store.maxActivePuts = 0
    try {
      const uploads = validations.map((validationId) => upload(validationId, { data: pdf }))

      await waitFor(() => store.activePuts === 2)
      // Com EVIDENCE_MAX_CONCURRENCY=2, só dois uploads entram no storage
      // enquanto o gate está fechado; o terceiro fica no semáforo.
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(store.maxActivePuts).toBe(2)

      releaseGate?.()
      const responses = await Promise.all(uploads)
      expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 201])
    } finally {
      store.putGate = null
      releaseGate?.()
    }
  })

  it('falha fechado quando o storage não está disponível', async () => {
    const validationId = await makeValidation(tenantA)
    store.failPut = new Error('test object storage down')
    try {
      expectProblem(await upload(validationId, { data: pdf }), 503, 'EVIDENCE_STORAGE_UNAVAILABLE')
    } finally {
      store.failPut = null
    }
    const graph = await graphOf(validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.evidence).toHaveLength(0)
    expect(graph.artifacts).toHaveLength(0)
  })

  it('compensa o objeto se claim_evidence falhar no banco', async () => {
    const validationId = await makeValidation(tenantClaimFail)
    const putsBefore = store.puts.length
    expectProblem(
      await upload(validationId, { data: pdf }, { key: keyClaimFail }),
      500,
      'EVIDENCE_PERSISTENCE_FAILED',
    )
    const createdKeys = store.puts.slice(putsBefore)
    expect(createdKeys).toHaveLength(1)
    expect(store.objects.has(createdKeys[0] ?? '')).toBe(false)
    const graph = await graphOf(validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.evidence).toHaveLength(0)
    expect(graph.artifacts).toHaveLength(0)
  })

  it('compensa o objeto se evidence_artifact falhar no banco', async () => {
    const validationId = await makeValidation(tenantArtifactFail)
    const putsBefore = store.puts.length
    expectProblem(
      await upload(validationId, { data: pdf }, { key: keyArtifactFail }),
      500,
      'EVIDENCE_PERSISTENCE_FAILED',
    )
    const createdKeys = store.puts.slice(putsBefore)
    expect(createdKeys).toHaveLength(1)
    expect(store.objects.has(createdKeys[0] ?? '')).toBe(false)
    const graph = await graphOf(validationId)
    expect(graph.claims).toHaveLength(0)
    expect(graph.evidence).toHaveLength(0)
    expect(graph.artifacts).toHaveLength(0)
  })

  it('registra falha de compensação sem vazar filename, conteúdo ou API key', async () => {
    const validationId = await makeValidation(tenantClaimFail)
    logLines.length = 0
    store.failDelete = new Error('test delete down')
    try {
      expectProblem(
        await upload(
          validationId,
          {
            data: pdf,
            filename: 'segredo-do-cliente.pdf',
          },
          { key: keyClaimFail },
        ),
        500,
        'EVIDENCE_PERSISTENCE_FAILED',
      )
    } finally {
      store.failDelete = null
    }

    const logs = logLines.join('\n')
    expect(logs).toContain('EVIDENCE_COMPENSATION_FAILED')
    expect(logs).not.toContain('segredo-do-cliente')
    expect(logs).not.toContain('%PDF-')
    expect(logs).not.toContain(keyClaimFail)
    expect(logs).not.toContain('tenants/')
  })

  it('usa retention_until e o job existente remove o artefato', async () => {
    const validationId = await makeValidation(tenantA)
    const res = await upload(validationId, { data: pdf })
    expect(res.statusCode).toBe(201)
    const graph = await graphOf(validationId)
    const artifact = graph.artifacts[0]
    if (artifact === undefined) throw new Error('artifact missing')
    const storageKey = artifact.storageKey

    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(t.validation.validationId, validationId))

    const removed = await validationRetentionTick(adminPool.db, store, 200, logger)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(store.objects.has(storageKey)).toBe(false)
    expect(store.deletes).toContain(storageKey)

    const remainingValidation = await adminPool.db
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    expect(remainingValidation).toHaveLength(0)
  })

  it('mantém RLS: outro tenant não lê o artefato criado', async () => {
    const validationId = await makeValidation(tenantA)
    const res = await upload(validationId, { data: pdf })
    expect(res.statusCode).toBe(201)
    const graph = await graphOf(validationId)
    const artifact = graph.artifacts[0]
    if (artifact === undefined) throw new Error('artifact missing')

    const visibleToB = await withTenant(appPool.db, tenantB, (tx) =>
      tx
        .select({ artifactId: t.evidenceArtifact.artifactId })
        .from(t.evidenceArtifact)
        .where(eq(t.evidenceArtifact.artifactId, artifact.artifactId)),
    )
    expect(visibleToB).toHaveLength(0)
  })
})
