import {
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  DOCUMENT_ANALYZER_ID,
  DOCUMENT_ANALYZER_VERSION,
  UPLOADED_DOCUMENT_SOURCE,
  type DocumentAnalysisResult,
} from '@comprova/core'
import { and, createDbPool, eq, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { makeDocumentAnalyzer, makeFakeObjectStore } from '@comprova/providers'
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
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeEvidenceTick } from '../../worker/src/modules/evidence-analysis/evidence-analysis.service.js'
import { verifyEvidenceTick } from '../../worker/src/modules/evidence-verification/evidence-verification.service.js'
import { buildApp } from '../src/app.js'

const PEPPER = 'test-pepper-evidence-verification'
const MAX_BYTES = 16_384
const FIXED_NOW = () => new Date('2026-10-22T12:00:00.000Z')
const CNPJ_BASICO = '12345678'
const MUNICIPIO_IBGE = 3550308

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

const tenantA = await createTenant(adminPool.db, { name: 'verification-a' })
const tenantB = await createTenant(adminPool.db, { name: 'verification-b' })
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

await adminPool.db
  .insert(t.refReceitaEmpresa)
  .values({
    cnpjBasico: CNPJ_BASICO,
    razaoSocial: 'Empresa Exemplo Ltda',
    snapshotMonth: '2026-10-01',
  })
  .onConflictDoNothing()
await adminPool.db
  .insert(t.refReceitaMunicipio)
  .values({
    codigoReceita: 3550308,
    codigoIbge: MUNICIPIO_IBGE,
    nomeNorm: 'SAO PAULO',
    uf: 'SP',
  })
  .onConflictDoNothing()

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

const pdfWithText = (lines: readonly string[]): Buffer => {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  const stream = Buffer.from(content, 'latin1')
  const objects: readonly string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let size = chunks[0]?.length ?? 0
  for (const [index, object] of objects.entries()) {
    offsets.push(size)
    const body = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1')
    chunks.push(body)
    size += body.length
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
      'latin1',
    ),
  )
  return Buffer.concat(chunks)
}

const bill = (holder: string | null, addressLine = 'Rua das Flores, 123, Apto 45'): readonly string[] => [
  'CONTA DE ENERGIA',
  ...(holder === null ? [] : [`Titular: ${holder}`]),
  `Endereço: ${addressLine}`,
  'Bairro: Centro',
  'Cidade: São Paulo',
  'UF: SP',
  'CEP: 01001-000',
  'Vencimento: 10/11/2026',
]

interface AddressOverrides {
  readonly numero?: string
  readonly cep?: string
  readonly logradouroNorm?: string
  readonly bairroNorm?: string
}

const makeValidationWithAddress = async (
  tenantId: string,
  overrides: AddressOverrides = {},
): Promise<string> => {
  const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
  const validationId = await createValidation(adminPool.db, tenantId, subjectId)
  const addressId = randomUUID()

  await adminPool.db.insert(t.canonicalAddress).values({
    addressId,
    buildingKey: randomBytes(32),
    countryCode: 'BR',
    uf: 'SP',
    municipioIbge: MUNICIPIO_IBGE,
    cep: overrides.cep ?? '01001000',
    logradouroNorm: overrides.logradouroNorm ?? 'RUA DAS FLORES',
    numero: overrides.numero ?? '123',
    bairroNorm: overrides.bairroNorm ?? 'CENTRO',
  })

  await adminPool.db
    .update(t.validation)
    .set({
      addressId,
      deepContext: {
        docDigitsValid: true,
        record: {
          cnpjBasico: CNPJ_BASICO,
          cnpjOrdem: '0001',
          cnpjDv: '95',
          nomeFantasia: 'Empresa Exemplo',
        },
      },
    })
    .where(eq(t.validation.validationId, validationId))

  return validationId
}

const multipart = (data: Buffer, filename = 'proof.pdf', contentType = 'application/pdf') => {
  const boundary = `----comprova-verification-${randomUUID()}`
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

const getValidation = async (validationId: string, key: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/validations/${validationId}`,
    headers: { authorization: `Bearer ${key}` },
  })

const graphOf = async (validationId: string) => {
  const claims = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  const claimIds = claims.map((row) => row.claimId)
  const evidence =
    claimIds.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.claimEvidence)
          .where(eq(t.claimEvidence.claimId, claimIds[0] as string))
  const intake = evidence.find((row) => row.source === 'customer_submitted_document')
  const artifacts =
    intake === undefined
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceArtifact)
          .where(eq(t.evidenceArtifact.claimEvidenceId, intake.claimEvidenceId))
  const artifactIds = artifacts.map((row) => row.artifactId)
  const analyses =
    artifactIds.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceAnalysis)
          .where(eq(t.evidenceAnalysis.artifactId, artifactIds[0] as string))
  return { claims, evidence, artifacts, analyses }
}

const analyzer = makeDocumentAnalyzer({ now: FIXED_NOW })

const runAnalysis = async () =>
  analyzeEvidenceTick({
    db: adminPool.db,
    store,
    analyzer,
    logger,
    maxBytes: MAX_BYTES,
    batchSize: 10,
  })

const runVerification = async (override: Partial<Parameters<typeof verifyEvidenceTick>[0]> = {}) =>
  verifyEvidenceTick({
    db: adminPool.db,
    logger,
    batchSize: 10,
    now: FIXED_NOW,
    ...override,
  })

const verificationRowsOf = async (validationId: string) => {
  const { evidence } = await graphOf(validationId)
  return evidence.filter((row) => row.source === UPLOADED_DOCUMENT_SOURCE)
}

const uploadedAndAnalyzed = async (
  tenantId: string,
  key: string,
  lines: readonly string[],
  overrides: AddressOverrides = {},
) => {
  const validationId = await makeValidationWithAddress(tenantId, overrides)
  const response = await upload(validationId, key, pdfWithText(lines))
  expect(response.statusCode).toBe(201)
  await runAnalysis()
  return validationId
}

/**
 * Cria uma análise terminal cujo claim aponta para uma validation inexistente.
 * O claim não tem FK para `validation` (por desenho), então o worker seleciona
 * o candidato e `loadContext` retorna `null` — o caso `skipped` do CodeRabbit.
 */
const createOrphanAnalysis = async (tenantId: string, analyzedAt: Date) => {
  const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
  const claimId = randomUUID()
  const intakeId = randomUUID()
  const artifactId = randomUUID()

  await adminPool.db.insert(t.claim).values({
    claimId,
    tenantId,
    validationId: randomUUID(),
    subjectId,
    addressId: null,
    type: 'business_registered_address',
    subjectType: 'organization',
    targetType: 'address',
  })

  await adminPool.db.insert(t.claimEvidence).values({
    claimEvidenceId: intakeId,
    tenantId,
    claimId,
    signalId: null,
    evidenceId: null,
    evidenceSha256: null,
    checker: 'customer_document_intake',
    checkerVersion: '1.0.0',
    stance: 'unknown',
    strength: 0,
    confidence: 0,
    source: CUSTOMER_DOCUMENT_INTAKE_SOURCE,
    observedAt: analyzedAt,
    ttlSeconds: 3600,
    expiresAt: new Date(analyzedAt.getTime() + 3_600_000),
    detail: { verification: { status: 'pending' } },
  })

  await adminPool.db.insert(t.evidenceArtifact).values({
    artifactId,
    tenantId,
    claimEvidenceId: intakeId,
    storageKey: `tenants/${tenantId}/evidence/${artifactId}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1,
    sha256: randomBytes(32),
    retentionUntil: new Date(analyzedAt.getTime() + 86_400_000),
  })

  const result: DocumentAnalysisResult = {
    contractVersion: DOCUMENT_ANALYSIS_CONTRACT_VERSION,
    analyzer: { id: DOCUMENT_ANALYZER_ID, version: DOCUMENT_ANALYZER_VERSION },
    status: 'completed',
    document: { status: 'analyzed', kind: 'unknown', issuedAt: null, issuedRaw: null },
    address: { status: 'not_extracted', value: null, raw: null },
    holder: { status: 'not_extracted', value: null, raw: null },
    limitations: [],
    errorCodes: [],
    analyzedAt: analyzedAt.toISOString(),
  }
  const analysisId = randomUUID()
  await adminPool.db.insert(t.evidenceAnalysis).values({
    analysisId,
    tenantId,
    artifactId,
    analyzer: DOCUMENT_ANALYZER_ID,
    analyzerVersion: DOCUMENT_ANALYZER_VERSION,
    contractVersion: DOCUMENT_ANALYSIS_CONTRACT_VERSION,
    status: 'completed',
    result,
    analyzedAt,
  })

  return { analysisId, claimId, artifactId }
}

interface PersistedVerification {
  readonly status: string
  readonly method: string
  readonly source: {
    readonly kind: string
    readonly id: string
    readonly authority: string | null
    readonly environment: string
  }
  readonly document: string
  readonly address: string
  readonly holder: string
  readonly analysis_id: string
  readonly artifact_id: string
  readonly analyzer: { readonly id: string; readonly version: string }
  readonly contract_version: string
  readonly observed_at: string
  readonly limitations: readonly string[]
  readonly error_codes: readonly string[]
  readonly comparison: {
    readonly address: {
      readonly compared_fields: readonly string[]
      readonly reason_codes: readonly string[]
    }
    readonly holder: {
      readonly reference: string
      readonly reason_codes: readonly string[]
    }
  }
}

const verificationOf = (
  row: { readonly detail: Record<string, unknown> } | undefined,
): PersistedVerification => {
  const value = row?.detail.verification
  if (value === null || typeof value !== 'object') throw new Error('verification detail missing')
  return value as PersistedVerification
}

describe('F1.3 — verificação do documento enviado', () => {
  it('materializa documento, endereço e titular independentes sem mudar o score', async () => {
    const validationId = await uploadedAndAnalyzed(tenantA, keyA, bill('Empresa Exemplo Ltda'))
    const before = logLines.length
    const processed = await runVerification()
    expect(processed).toBeGreaterThanOrEqual(1)

    const rows = await verificationRowsOf(validationId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      source: UPLOADED_DOCUMENT_SOURCE,
      checker: 'document_upload_verification',
      stance: 'unknown',
      strength: 0,
      confidence: 0,
      signalId: null,
    })
    expect(row?.detail).toMatchObject({
      verification: {
        status: 'completed',
        method: 'content_extraction',
        document: 'inconclusive',
        address: 'matches',
        holder: 'matches',
        analyzer: { id: 'text_document', version: '1.1.0' },
        contract_version: '2',
        limitations: expect.arrayContaining(['AUTHENTICITY_NOT_VERIFIED']),
      },
    })

    // O detalhe persistido não copia nome/endereço/CEP extraídos.
    const serialized = JSON.stringify(row?.detail)
    expect(serialized).not.toContain('Empresa Exemplo')
    expect(serialized).not.toContain('Rua das Flores')
    expect(serialized).not.toContain('01001-000')
    const newLogs = logLines.slice(before).join('\n')
    expect(newLogs).not.toContain('Empresa Exemplo')
    expect(newLogs).not.toContain('Rua das Flores')
    expect(newLogs).not.toContain('01001-000')

    const get = await getValidation(validationId, keyA)
    expect(get.statusCode).toBe(200)
    expect(get.json().evidence_verification).toMatchObject({
      status: 'completed',
      document: 'inconclusive',
      address: 'matches',
      holder: 'matches',
      analysis_id: verificationOf(row).analysis_id,
    })
    // A verificação não cria signal; o score/veredito continuam intocados.
    expect(get.json().signals).toEqual([])
    expect(get.json().score).toBeNull()
  })

  it('compara endereço e titular e retorna differs quando os campos fortes conflitam', async () => {
    const addressValidation = await uploadedAndAnalyzed(tenantA, keyA, bill('Empresa Exemplo Ltda'), {
      numero: '999',
    })
    const holderValidation = await uploadedAndAnalyzed(tenantA, keyA, bill('Outra Empresa Ltda'))
    await runVerification()

    const addressRow = (await verificationRowsOf(addressValidation))[0]
    expect(verificationOf(addressRow).address).toBe('differs')
    expect(verificationOf(addressRow).comparison.address.reason_codes).toContain('NUMERO_MISMATCH')

    const holderRow = (await verificationRowsOf(holderValidation))[0]
    expect(verificationOf(holderRow).holder).toBe('differs')
    expect(verificationOf(holderRow).comparison.holder.reason_codes).toContain('NAME_MISMATCH')
  })

  it('usa not_extracted quando o titular não foi extraído', async () => {
    const validationId = await uploadedAndAnalyzed(tenantA, keyA, bill(null))
    await runVerification()

    const row = (await verificationRowsOf(validationId))[0]
    expect(row?.detail.verification).toMatchObject({
      address: 'matches',
      holder: 'not_extracted',
      document: 'inconclusive',
    })
    expect(verificationOf(row).comparison.holder.reason_codes).toContain('HOLDER_NOT_EXTRACTED')
  })

  it('PDF sem camada textual não gera differs', async () => {
    const validationId = await uploadedAndAnalyzed(tenantA, keyA, [])
    await runVerification()

    const row = (await verificationRowsOf(validationId))[0]
    expect(row?.detail.verification).toMatchObject({
      status: 'inconclusive',
      document: 'inconclusive',
      address: 'not_extracted',
      holder: 'not_extracted',
    })
    expect(verificationOf(row).address).not.toBe('differs')
    expect(verificationOf(row).holder).not.toBe('differs')
  })

  it('documento inválido não produz evidência válida', async () => {
    const validationId = await makeValidationWithAddress(tenantA)
    const response = await upload(validationId, keyA, Buffer.from('%PDF-1.4\nthis is not a valid pdf'))
    expect(response.statusCode).toBe(201)
    await runAnalysis()
    await runVerification()

    const row = (await verificationRowsOf(validationId))[0]
    expect(row).toMatchObject({
      stance: 'unknown',
      strength: 0,
      confidence: 0,
    })
    expect(row?.detail.verification).toMatchObject({
      status: 'invalid',
      document: 'invalid',
      address: 'not_extracted',
      holder: 'not_extracted',
    })
  })

  it('reprocessamento não duplica e nova versão preserva a anterior', async () => {
    const validationId = await uploadedAndAnalyzed(tenantA, keyA, bill('Empresa Exemplo Ltda'))
    await runVerification()
    await runVerification()

    const firstRows = await verificationRowsOf(validationId)
    expect(firstRows).toHaveLength(1)
    const first = firstRows[0]
    const { analyses, artifacts } = await graphOf(validationId)
    const firstAnalysis = analyses.find(
      (analysis) => analysis.analysisId === verificationOf(first).analysis_id,
    )
    const baseResult = firstAnalysis?.result
    if (baseResult === null || baseResult === undefined) throw new Error('analysis result missing')
    const artifactId = artifacts[0]?.artifactId
    expect(artifactId).toBeDefined()

    const nextResult = {
      ...baseResult,
      analyzer: { id: 'text_document', version: '1.2.0' },
      analyzedAt: '2026-10-22T13:00:00.000Z',
      address: {
        status: 'extracted' as const,
        raw: 'Endereço: Rua das Flores, 999',
        value: {
          logradouro: 'RUA DAS FLORES',
          numero: '999',
          complemento: null,
          bairro: 'CENTRO',
          cidade: 'SAO PAULO',
          uf: 'SP',
          cep: '01001000',
          raw: 'Rua das Flores, 999',
        },
      },
    }
    const secondAnalysisId = randomUUID()
    await adminPool.db.insert(t.evidenceAnalysis).values({
      analysisId: secondAnalysisId,
      tenantId: tenantA,
      artifactId: artifactId as string,
      analyzer: 'text_document',
      analyzerVersion: '1.2.0',
      contractVersion: '2',
      status: 'completed',
      result: nextResult,
      analyzedAt: new Date('2026-10-22T13:00:00.000Z'),
    })

    await runVerification({ analyzerVersion: '1.2.0' })
    const rows = await verificationRowsOf(validationId)
    expect(rows).toHaveLength(2)

    const oldRow = rows.find((row) => verificationOf(row).analysis_id === verificationOf(first).analysis_id)
    const newRow = rows.find((row) => verificationOf(row).analysis_id === secondAnalysisId)
    expect(verificationOf(oldRow).address).toBe('matches')
    expect(verificationOf(newRow).address).toBe('differs')
    expect(newRow?.checkerVersion).toBe('1.0.0+1.2.0+c2')

    const get = await getValidation(validationId, keyA)
    expect(get.json().evidence_verification.analysis_id).toBe(secondAnalysisId)
    expect(get.json().evidence_verification.address).toBe('differs')
  })

  it('isola tenants e não expõe a verificação de outro tenant', async () => {
    const validationA = await uploadedAndAnalyzed(tenantA, keyA, bill('Empresa Exemplo Ltda'))
    const validationB = await uploadedAndAnalyzed(tenantB, keyB, bill('Empresa Exemplo Ltda'))
    await runVerification()

    const rowsA = await verificationRowsOf(validationA)
    const rowsB = await verificationRowsOf(validationB)
    expect(rowsA).toHaveLength(1)
    expect(rowsB).toHaveLength(1)
    expect(rowsA[0]?.tenantId).toBe(tenantA)
    expect(rowsB[0]?.tenantId).toBe(tenantB)

    const cross = await getValidation(validationA, keyB)
    expect(cross.statusCode).toBe(404)

    const { claims } = await graphOf(validationA)
    const claimA = claims[0]?.claimId
    expect(claimA).toBeDefined()
    const visibleToB = await withTenant(appPool.db, tenantB, (tx) =>
      tx
        .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
        .from(t.claimEvidence)
        .where(
          and(
            eq(t.claimEvidence.claimId, claimA as string),
            eq(t.claimEvidence.source, UPLOADED_DOCUMENT_SOURCE),
          ),
        ),
    )
    expect(visibleToB).toHaveLength(0)
  })

  it('não deixa um candidato sem contexto bloquear outro tenant', async () => {
    const orphan = await createOrphanAnalysis(tenantA, new Date('2026-10-22T10:00:00.000Z'))
    const validationId = await uploadedAndAnalyzed(tenantB, keyB, bill('Empresa Exemplo Ltda'))
    const before = logLines.length

    const processed = await runVerification({ batchSize: 10 })
    expect(processed).toBeGreaterThanOrEqual(2)
    expect(await verificationRowsOf(validationId)).toHaveLength(1)

    const attempts = await adminPool.db
      .select()
      .from(t.evidenceVerificationAttempt)
      .where(eq(t.evidenceVerificationAttempt.analysisId, orphan.analysisId))
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      tenantId: tenantA,
      attempts: 1,
      lastErrorCode: 'CONTEXT_MISSING',
    })
    expect(attempts[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())

    // O backoff persistente impede que o próximo tick volte ao mesmo candidato.
    await runVerification({ batchSize: 10 })
    const afterRetry = await adminPool.db
      .select({ attempts: t.evidenceVerificationAttempt.attempts })
      .from(t.evidenceVerificationAttempt)
      .where(eq(t.evidenceVerificationAttempt.analysisId, orphan.analysisId))
    expect(afterRetry).toEqual([{ attempts: 1 }])

    const newLogs = logLines.slice(before).join('\n')
    expect(newLogs).not.toContain('Empresa Exemplo')
    expect(newLogs).not.toContain('Rua das Flores')
    expect(newLogs).not.toContain('01001-000')
  })
})
