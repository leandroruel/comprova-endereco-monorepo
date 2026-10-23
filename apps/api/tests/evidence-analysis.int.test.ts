import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, inArray, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import {
  DocumentAnalyzerUnavailableError,
  makeDocumentAnalyzer,
  makeFakeObjectStore,
  type DocumentAnalyzer,
} from '@comprova/providers'
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
import { deflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeEvidenceTick } from '../../worker/src/modules/evidence-analysis/evidence-analysis.service.js'
import { validationRetentionTick } from '../../worker/src/modules/retention/retention.service.js'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-evidence-analysis'
const MAX_BYTES = 8192
const FIXED_NOW = () => new Date('2026-10-22T12:00:00.000Z')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const store = makeFakeObjectStore()
const logLines: string[] = []
const logger = createLogger({
  level: 'debug',
  stream: { write: (line) => logLines.push(line) },
})

const tenantA = await createTenant(adminPool.db, { name: 'analysis-a' })
const tenantB = await createTenant(adminPool.db, { name: 'analysis-b' })
const keyA = (await createApiKey(adminPool.db, tenantA, PEPPER)).plaintext
const keyB = (await createApiKey(adminPool.db, tenantB, PEPPER)).plaintext

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

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const escapePdf = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const pdfWithText = (lines: readonly string[], compressed = false): Buffer => {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  if (!compressed) {
    return Buffer.from(
      `%PDF-1.4\n` +
        `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
        `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
        `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
        `4 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
        `trailer << /Root 1 0 R >>\n%%EOF\n`,
      'latin1',
    )
  }
  const body = deflateSync(Buffer.from(content, 'latin1'))
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n` +
        `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
        `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
        `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
        `4 0 obj << /Length ${body.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1',
    ),
    body,
    Buffer.from(`\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1'),
  ])
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])

const fullBill = [
  'CONTA DE ENERGIA',
  'Titular: Maria da Silva',
  'CPF: 529.982.247-25',
  'Endereço: Rua das Flores, 123, Apto 45',
  'Bairro: Centro',
  'Cidade: São Paulo',
  'UF: SP',
  'CEP: 01001-000',
  'Vencimento: 10/11/2026',
]

const makeValidation = async (tenantId: string): Promise<string> => {
  const subjectId = await createSubject(adminPool.db, tenantId)
  return createValidation(adminPool.db, tenantId, subjectId)
}

const multipart = (data: Buffer, filename = 'proof.pdf', contentType = 'application/pdf') => {
  const boundary = `----comprova-analysis-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const upload = async (
  validationId: string,
  key: string,
  data: Buffer,
  filename = 'proof.pdf',
  contentType = 'application/pdf',
) => {
  const body = multipart(data, filename, contentType)
  return app.inject({
    method: 'POST',
    url: `/v1/validations/${validationId}/evidence`,
    headers: { authorization: `Bearer ${key}`, ...body.headers },
    payload: body.payload,
  })
}

const graphOf = async (validationId: string) => {
  const claims = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  const claimIds = claims.map((row) => row.claimId)
  const evidence =
    claimIds.length === 0
      ? []
      : await adminPool.db.select().from(t.claimEvidence).where(inArray(t.claimEvidence.claimId, claimIds))
  const evidenceIds = evidence.map((row) => row.claimEvidenceId)
  const artifacts =
    evidenceIds.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceArtifact)
          .where(inArray(t.evidenceArtifact.claimEvidenceId, evidenceIds))
  const artifactIds = artifacts.map((row) => row.artifactId)
  const analyses =
    artifactIds.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceAnalysis)
          .where(inArray(t.evidenceAnalysis.artifactId, artifactIds))
  return { claims, evidence, artifacts, analyses }
}

const analyzer = makeDocumentAnalyzer({ now: FIXED_NOW })

const runTick = async (override: Partial<Parameters<typeof analyzeEvidenceTick>[0]> = {}) =>
  analyzeEvidenceTick({
    db: adminPool.db,
    store,
    analyzer,
    logger,
    maxBytes: MAX_BYTES,
    batchSize: 10,
    ...override,
  })

describe('F1.2 — análise do comprovante', () => {
  it('enfileira no intake e extrai campos estruturados sem mudar a observação pending', async () => {
    const validationId = await makeValidation(tenantA)
    const res = await upload(validationId, keyA, pdfWithText(fullBill))
    expect(res.statusCode).toBe(201)

    const before = await graphOf(validationId)
    expect(before.analyses).toHaveLength(1)
    expect(before.analyses[0]?.status).toBe('pending')
    expect(before.evidence[0]?.detail).toMatchObject({
      verification: { status: 'pending', document: null, address: null, holder: null },
    })

    const processed = await runTick()
    expect(processed).toBeGreaterThanOrEqual(1)

    const after = await graphOf(validationId)
    const analysis = after.analyses[0]
    expect(analysis?.status).toBe('completed')
    expect(analysis?.result).toMatchObject({
      status: 'completed',
      document: { status: 'analyzed', kind: 'electricity_bill' },
      address: {
        status: 'extracted',
        value: { logradouro: 'RUA DAS FLORES', numero: '123', uf: 'SP', cep: '01001000' },
      },
      holder: { status: 'extracted', value: { name: 'Maria da Silva', taxIdType: 'CPF' } },
    })
    // A análise não reescreve a observação `unknown`/`pending` (F1.1).
    expect(after.evidence[0]?.stance).toBe('unknown')
    expect(after.evidence[0]?.strength).toBe(0)
  })

  it('documento sem endereço produz address = not_extracted', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(
      validationId,
      keyA,
      pdfWithText(['CONTA DE ENERGIA', 'Titular: Maria da Silva', 'CPF: 529.982.247-25']),
    )
    await runTick()

    const { analyses } = await graphOf(validationId)
    const result = analyses[0]?.result as { address: { status: string }; holder: { status: string } } | null
    expect(result?.address.status).toBe('not_extracted')
    expect(result?.holder.status).toBe('extracted')
  })

  it('documento sem titular produz holder = not_extracted', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(
      validationId,
      keyA,
      pdfWithText(['CONTA DE AGUA', 'Endereço: Rua das Flores, 123', 'CEP: 01001-000']),
    )
    await runTick()

    const { analyses } = await graphOf(validationId)
    const result = analyses[0]?.result as { address: { status: string }; holder: { status: string } } | null
    expect(result?.holder.status).toBe('not_extracted')
    expect(result?.address.status).toBe('extracted')
  })

  it('documento inválido não produz address = differs automaticamente', async () => {
    const validationId = await makeValidation(tenantA)
    const invalidPdf = Buffer.from('%PDF-1.4\nnot a real pdf\n')
    expect((await upload(validationId, keyA, invalidPdf)).statusCode).toBe(201)
    await runTick()

    const { analyses, evidence } = await graphOf(validationId)
    const result = analyses[0]?.result as {
      status: string
      document: { status: string }
      address: { status: string }
    } | null
    expect(result?.status).toBe('inconclusive')
    expect(result?.document.status).toBe('invalid')
    expect(result?.address.status).toBe('unknown')
    expect(evidence[0]?.stance).toBe('unknown')
  })

  it('formato sem suporte (imagem sem OCR) vira unsupported, não contradição', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, jpeg, 'proof.jpg', 'image/jpeg')
    await runTick()

    const { analyses, evidence } = await graphOf(validationId)
    const result = analyses[0]?.result as {
      status: string
      document: { status: string }
      address: { status: string }
      errorCodes: string[]
    } | null
    expect(result?.status).toBe('unsupported')
    expect(result?.document.status).toBe('unsupported')
    expect(result?.address.status).toBe('unknown')
    expect(result?.errorCodes).toContain('OCR_NOT_IMPLEMENTED')
    expect(evidence[0]?.stance).toBe('unknown')
  })

  it('analisador indisponível vira unavailable, não address = differs', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    const unavailable: DocumentAnalyzer = {
      id: analyzer.id,
      version: analyzer.version,
      contractVersion: analyzer.contractVersion,
      analyze: async () => {
        throw new DocumentAnalyzerUnavailableError('provider_down')
      },
    }
    await runTick({ analyzer: unavailable })

    const { analyses, evidence } = await graphOf(validationId)
    const result = analyses[0]?.result as {
      status: string
      document: { status: string }
      address: { status: string }
    } | null
    expect(result?.status).toBe('unavailable')
    expect(result?.document.status).toBe('unavailable')
    expect(result?.address.status).toBe('unknown')
    expect(evidence[0]?.stance).toBe('unknown')
  })

  it('falha transitória de leitura deixa a análise em analyzing para retry', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    const failingStore = {
      ...store,
      get: async () => {
        throw new Error('timeout')
      },
    }

    await runTick({ store: failingStore })

    const { analyses } = await graphOf(validationId)
    expect(analyses[0]?.status).toBe('analyzing')
    expect(analyses[0]?.result).toBeNull()
    expect(analyses[0]?.attempts).toBe(1)
    expect(analyses[0]?.lastError).toBe('OBJECT_UNAVAILABLE')
  })

  it('limita tentativas e terminaliza como failed após esgotar', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    const failingStore = {
      ...store,
      get: async () => {
        throw new Error('timeout')
      },
    }

    await runTick({ store: failingStore, maxAttempts: 1 })
    const first = (await graphOf(validationId)).analyses[0]
    expect(first?.status).toBe('analyzing')
    if (first === undefined) return

    await adminPool.db
      .update(t.evidenceAnalysis)
      .set({ updatedAt: new Date(Date.now() - 600_000) })
      .where(eq(t.evidenceAnalysis.analysisId, first.analysisId))

    await runTick({ store: failingStore, maxAttempts: 1 })

    const after = (await graphOf(validationId)).analyses[0]
    expect(after?.status).toBe('failed')
    expect(after?.result).toMatchObject({
      status: 'failed',
      errorCodes: ['ANALYSIS_ATTEMPTS_EXCEEDED'],
    })
    expect(after?.lastError).toBe('ANALYSIS_ATTEMPTS_EXCEEDED')
    expect(after?.attempts).toBe(2)
  })

  it('saída inválida do analisador vira failed, sem ficar presa em analyzing', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    const malformed: DocumentAnalyzer = {
      id: analyzer.id,
      version: analyzer.version,
      contractVersion: analyzer.contractVersion,
      analyze: async () => ({
        contractVersion: analyzer.contractVersion,
        analyzer: { id: analyzer.id, version: analyzer.version },
        status: 'completed',
        document: { status: 'analyzed', kind: 'unknown', issuedAt: null, issuedRaw: null },
        address: { status: 'unknown', value: null, raw: null },
        holder: { status: 'unknown', value: null, raw: null },
        limitations: [],
        errorCodes: [],
        analyzedAt: 'not-a-date',
      }),
    }
    await runTick({ analyzer: malformed })

    const { analyses } = await graphOf(validationId)
    expect(analyses[0]?.status).toBe('failed')
    expect(analyses[0]?.result).toMatchObject({ status: 'failed', errorCodes: ['INVALID_ANALYZER_OUTPUT'] })
    expect(analyses[0]?.attempts).toBe(1)
  })

  it('retry não duplica e não reescreve o resultado terminal', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    await runTick()
    const first = (await graphOf(validationId)).analyses[0]
    expect(first?.status).toBe('completed')
    await runTick()

    const { analyses } = await graphOf(validationId)
    expect(analyses).toHaveLength(1)
    expect(analyses[0]?.analysisId).toBe(first?.analysisId)
    expect(analyses[0]?.attempts).toBe(1)
  })

  it('replay do upload não cria segunda análise nem reanalisa o artefato', async () => {
    const validationId = await makeValidation(tenantA)
    expect((await upload(validationId, keyA, pdfWithText(fullBill))).statusCode).toBe(201)
    await runTick()
    const first = (await graphOf(validationId)).analyses[0]
    expect(first?.status).toBe('completed')

    const replay = await upload(validationId, keyA, pdfWithText(fullBill))
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    await runTick()

    const { analyses } = await graphOf(validationId)
    expect(analyses).toHaveLength(1)
    expect(analyses[0]?.analysisId).toBe(first?.analysisId)
    expect(analyses[0]?.attempts).toBe(1)
  })

  it('execução concorrente do mesmo artifact mantém uma única análise terminal', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    await Promise.all([runTick(), runTick()])

    const { analyses } = await graphOf(validationId)
    expect(analyses).toHaveLength(1)
    expect(analyses[0]?.status).toBe('completed')
  })

  it('tenant isolation: A não enxerga a análise de B e não aponta para artefato de B', async () => {
    const validationA = await makeValidation(tenantA)
    const validationB = await makeValidation(tenantB)
    await upload(validationA, keyA, pdfWithText(fullBill))
    await upload(validationB, keyB, pdfWithText(fullBill))
    await runTick()

    const { artifacts: artifactsA } = await graphOf(validationA)
    const { artifacts } = await graphOf(validationB)
    const artifactA = artifactsA[0]
    const artifactB = artifacts[0]
    expect(artifactA).toBeDefined()
    expect(artifactB).toBeDefined()
    if (artifactA === undefined || artifactB === undefined) return

    const visibleToA = await withTenant(appPool.db, tenantA, async (tx) =>
      tx.select().from(t.evidenceAnalysis).where(eq(t.evidenceAnalysis.artifactId, artifactA.artifactId)),
    )
    const visibleToB = await withTenant(appPool.db, tenantB, async (tx) =>
      tx.select().from(t.evidenceAnalysis).where(eq(t.evidenceAnalysis.artifactId, artifactB.artifactId)),
    )
    expect(visibleToA).toHaveLength(1)
    expect(visibleToB).toHaveLength(1)
    expect(visibleToA[0]?.tenantId).toBe(tenantA)
    expect(visibleToB[0]?.tenantId).toBe(tenantB)

    await expect(
      withTenant(appPool.db, tenantA, async (tx) =>
        tx.insert(t.evidenceAnalysis).values({
          analysisId: randomUUID(),
          tenantId: tenantA,
          artifactId: artifactB.artifactId,
          analyzer: 'cross_tenant',
          analyzerVersion: '1',
          contractVersion: '1',
          status: 'pending',
        }),
      ),
    ).rejects.toThrow()
  })

  it('não coloca PII nos logs', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    logLines.length = 0
    await runTick()

    const logs = logLines.join('\n')
    expect(logs).not.toContain('Maria')
    expect(logs).not.toContain('529.982.247-25')
    expect(logs).not.toContain('Rua das Flores')
    expect(logs).not.toContain('01001-000')
    expect(logs).not.toContain('%PDF')
  })

  it('retenção remove a análise junto do artefato', async () => {
    const validationId = await makeValidation(tenantA)
    await upload(validationId, keyA, pdfWithText(fullBill))
    await runTick()
    expect((await graphOf(validationId)).analyses).toHaveLength(1)

    await adminPool.db
      .update(t.validation)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(t.validation.validationId, validationId))

    const removed = await validationRetentionTick(adminPool.db, store)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect((await graphOf(validationId)).analyses).toHaveLength(0)
  })
})
