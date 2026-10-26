import { loadPolicy, policyHashOf, FISCAL_SOURCE_KIND } from '@comprova/core'
import { createDbPool, eq, runMigrations, sql } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import { makeDocumentAnalyzer, makeFakeFiscalAdapter, makeFakeObjectStore } from '@comprova/providers'
import {
  createSubject,
  createTenant,
  createApiKey,
  createValidation,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeEvidenceTick } from '../../worker/src/modules/evidence-analysis/evidence-analysis.service.js'
import { verifyEvidenceTick } from '../../worker/src/modules/evidence-verification/evidence-verification.service.js'
import { verifyFiscalTick } from '../../worker/src/modules/fiscal-verification/fiscal-verification.tick.js'
import { deepEnrich } from '../../worker/src/modules/deep-enrich/deep-enrich.service.js'
import { buildApp } from '../src/app.js'

/**
 * Vertical slice E2E — gatilho da consulta fiscal (tick) sobre a referência
 * extraída do comprovante real:
 *
 *   upload do PDF com QR NF3e → análise (F1.2) → verificação (F1.3)
 *     → tick fiscal (F2.2b) consulta o autorizador e materializa
 *     → reavaliação (deep path) inclui a evidência fiscal no assessment
 *     → GET expõe a consulta fiscal sem PII nem metadados de auditoria.
 */

const PEPPER = 'test-pepper-fiscal-tick'
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
const logger = createLogger({ level: 'debug' })

const tenantA = await createTenant(adminPool.db, { name: 'fiscal-tick-a' })
const tenantB = await createTenant(adminPool.db, { name: 'fiscal-tick-b' })
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
  .values({ codigoReceita: 3550308, codigoIbge: MUNICIPIO_IBGE, nomeNorm: 'SAO PAULO', uf: 'SP' })
  .onConflictDoNothing()

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const fiscalPolicyYaml = readFileSync(path.join(repoRoot, 'policies', '2026.14.1.yaml'), 'utf8')
const fiscalPolicy = loadPolicy(fiscalPolicyYaml)
const fiscalPolicyHash = policyHashOf(fiscalPolicyYaml)

// Fixture compartilhada: PDF com QR NF3e raster (SVRS/SP — aceito pelo adapter
// de teste; a referência é extraída pelo analyzer real).
const nf3eQrPdf = readFileSync(path.join(repoRoot, 'packages/providers/src/fiscal/__fixtures__/nf3e-qr.pdf'))

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const makeValidationWithAddress = async (tenantId: string): Promise<string> => {
  const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
  const validationId = await createValidation(adminPool.db, tenantId, subjectId)
  const addressId = randomUUID()
  await adminPool.db.insert(t.canonicalAddress).values({
    addressId,
    buildingKey: randomBytes(32),
    countryCode: 'BR',
    uf: 'SP',
    municipioIbge: MUNICIPIO_IBGE,
    cep: '01001000',
    logradouroNorm: 'RUA DAS FLORES',
    numero: '123',
    bairroNorm: 'CENTRO',
  })
  await adminPool.db
    .update(t.validation)
    .set({
      addressId,
      deepContext: {
        docDigitsValid: true,
        record: { cnpjBasico: CNPJ_BASICO, cnpjOrdem: '0001', cnpjDv: '95', nomeFantasia: 'Empresa Exemplo' },
      },
    })
    .where(eq(t.validation.validationId, validationId))
  return validationId
}

const multipart = (data: Buffer, filename = 'proof.pdf', contentType = 'application/pdf') => {
  const boundary = `----comprova-fiscal-tick-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const upload = async (validationId: string, key: string, data: Buffer) => {
  const body = multipart(data)
  return app.inject({
    method: 'POST',
    url: `/v1/validations/${validationId}/evidence`,
    headers: { authorization: `Bearer ${key}`, ...body.headers },
    payload: body.payload,
  })
}

const analyzer = makeDocumentAnalyzer({ now: FIXED_NOW })

const runAnalysis = () =>
  analyzeEvidenceTick({ db: adminPool.db, store, analyzer, logger, maxBytes: MAX_BYTES, batchSize: 10 })

const runVerification = () => verifyEvidenceTick({ db: adminPool.db, logger, batchSize: 10, now: FIXED_NOW })

/** Sobe o fluxo até a verificação F1.3 materializada (ponto de entrada do tick). */
const uploadedAndVerified = async (tenantId: string, key: string): Promise<string> => {
  const validationId = await makeValidationWithAddress(tenantId)
  const response = await upload(validationId, key, nf3eQrPdf)
  expect(response.statusCode).toBe(201)
  await runAnalysis()
  await runVerification()
  return validationId
}

const claimIdOf = async (validationId: string): Promise<string> => {
  const rows = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  const claimId = rows[0]?.claimId
  if (claimId === undefined) throw new Error('claim nao criado')
  return claimId
}

const fiscalRowsOf = async (validationId: string) => {
  const claimId = await claimIdOf(validationId)
  const rows = await adminPool.db.select().from(t.claimEvidence).where(eq(t.claimEvidence.claimId, claimId))
  return rows.filter((row) => row.source === FISCAL_SOURCE_KIND['nf3e'])
}

const runTick = async (
  override: Partial<Parameters<typeof verifyFiscalTick>[0]> = {},
): Promise<{ processed: number; reassessCalls: { tenantId: string; validationId: string }[] }> => {
  const reassessCalls: { tenantId: string; validationId: string }[] = []
  const processed = await verifyFiscalTick({
    db: adminPool.db,
    adapter: makeFakeFiscalAdapter({ document: 'authentic', address: 'matches', holder: 'matches' }),
    logger,
    reassess: async (tenantId, validationId) => {
      reassessCalls.push({ tenantId, validationId })
    },
    now: FIXED_NOW,
    ...override,
  })
  return { processed, reassessCalls }
}

describe('fiscal verification tick — vertical slice', () => {
  it('não consulta antes da verificação do documento (F1.3) materializar', async () => {
    const validationId = await makeValidationWithAddress(tenantA)
    expect((await upload(validationId, keyA, nf3eQrPdf)).statusCode).toBe(201)
    await runAnalysis()
    // Ainda sem runVerification: o tick não deve processar nada.
    const { processed, reassessCalls } = await runTick()
    expect(processed).toBe(0)
    expect(reassessCalls).toEqual([])
    expect(await fiscalRowsOf(validationId)).toEqual([])
  })

  it('consulta pela referência extraída, materializa e reavalia o claim (fluxo completo)', async () => {
    const validationId = await uploadedAndVerified(tenantA, keyA)

    const reassessCalls: { tenantId: string; validationId: string }[] = []
    const processed = await verifyFiscalTick({
      db: adminPool.db,
      adapter: makeFakeFiscalAdapter({ document: 'authentic', address: 'matches', holder: 'matches' }),
      logger,
      reassess: async (tenantId, id) => {
        reassessCalls.push({ tenantId, validationId: id })
        await deepEnrich(
          {
            db: adminPool.db,
            t1Checkers: [],
            policy: fiscalPolicy,
            policyHash: fiscalPolicyHash,
            clock: { now: FIXED_NOW },
          },
          { tenantId, validationId: id },
        )
      },
      now: FIXED_NOW,
    })

    expect(processed).toBeGreaterThanOrEqual(1)
    expect(reassessCalls).toContainEqual({ tenantId: tenantA, validationId })

    // Evidência fiscal materializada a partir da referência do QR.
    const fiscal = await fiscalRowsOf(validationId)
    expect(fiscal).toHaveLength(1)
    expect(fiscal[0]).toMatchObject({
      source: 'fiscal_nf3e',
      checker: 'nf3e_verification',
      stance: 'supports',
      strength: 0,
      confidence: 0,
      signalId: null,
    })
    expect(fiscal[0]?.detail).toMatchObject({
      verification: {
        status: 'completed',
        document: 'authentic',
        address: 'matches',
        holder: 'matches',
      },
    })

    // A reavaliação (deep path) incluiu a evidência fiscal no assessment:
    // força da policy 0.4 × 0.8 = 0.32 → score > 0.
    const [validation] = await adminPool.db
      .select({ verdict: t.validation.verdict, score: t.validation.score })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    expect(validation?.verdict).not.toBeNull()
    expect(validation?.score).toBeGreaterThan(0.3)
  })

  it('é idempotente: um segundo tick não consulta nem reavalia de novo', async () => {
    const validationId = await uploadedAndVerified(tenantA, keyA)
    const first = await runTick()
    expect(first.processed).toBe(1)
    const second = await runTick()
    expect(second.processed).toBe(0)
    expect(second.reassessCalls).toEqual([])
    expect(await fiscalRowsOf(validationId)).toHaveLength(1)
  })

  it('mantém a taxonomia: consulta indisponível vira observação neutra, não "falha"', async () => {
    const validationId = await uploadedAndVerified(tenantA, keyA)
    const { processed, reassessCalls } = await runTick({
      adapter: makeFakeFiscalAdapter({ document: 'unavailable', address: 'not_extracted' }),
    })
    expect(processed).toBe(1)
    expect(reassessCalls).toHaveLength(1)

    const [fiscal] = await fiscalRowsOf(validationId)
    expect(fiscal).toMatchObject({ stance: 'unknown' })
    expect(fiscal?.detail).toMatchObject({
      verification: { status: 'unavailable', document: 'unavailable' },
    })
  })

  it('reavaliação que falha é retentada no próximo tick (sem comando manual)', async () => {
    const validationId = await uploadedAndVerified(tenantA, keyA)

    const failing = await runTick({
      reassess: async () => {
        throw new Error('reassess boom')
      },
    })
    expect(failing.processed).toBe(1)
    expect(await fiscalRowsOf(validationId)).toHaveLength(1)

    // Backoff futuro: o candidato não volta imediatamente…
    const immediate = await runTick()
    expect(immediate.processed).toBe(0)

    // …mas quando o backoff vence, a reavaliação é retentada (a consulta em si
    // é idempotente: `duplicate`, sem nova linha de evidência).
    await adminPool.db.execute(
      sql`UPDATE evidence_verification_attempt SET next_attempt_at = now() - interval '1 second'`,
    )

    const retried = await runTick()
    expect(retried.processed).toBe(1)
    expect(retried.reassessCalls).toEqual([{ tenantId: tenantA, validationId }])
    // A consulta não duplicou: continua exatamente uma evidência fiscal.
    expect(await fiscalRowsOf(validationId)).toHaveLength(1)
  })

  it('expõe a consulta fiscal no GET sem PII nem metadados de auditoria', async () => {
    const validationId = await uploadedAndVerified(tenantA, keyA)
    await runTick()

    const get = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationId}`,
      headers: { authorization: `Bearer ${keyA}` },
    })
    expect(get.statusCode).toBe(200)
    const body = get.json()
    expect(body.fiscal_verification).toMatchObject({
      status: 'completed',
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      source: { kind: 'fiscal_nf3e', id: 'nf3e', authority: 'SVRS' },
    })

    // Nada de hash da referência, IP resolvido, digest da resposta ou URL.
    const raw = get.body
    expect(raw).not.toContain('document_ref_hash')
    expect(raw).not.toContain('resolved_ip')
    expect(raw).not.toContain('response_sha256')
    expect(raw).not.toContain('requested_url')
    expect(raw).not.toContain('svrs.rs.gov.br')

    // Isolamento: o tenant B não vê a validação (nem a consulta fiscal) do A.
    const cross = await app.inject({
      method: 'GET',
      url: `/v1/validations/${validationId}`,
      headers: { authorization: `Bearer ${keyB}` },
    })
    expect(cross.statusCode).toBe(404)
  })

  it('processa os dois tenants de forma independente', async () => {
    const validationA = await uploadedAndVerified(tenantA, keyA)
    const validationB = await uploadedAndVerified(tenantB, keyB)

    const { processed, reassessCalls } = await runTick()
    expect(processed).toBeGreaterThanOrEqual(2)
    expect(reassessCalls).toEqual(
      expect.arrayContaining([
        { tenantId: tenantA, validationId: validationA },
        { tenantId: tenantB, validationId: validationB },
      ]),
    )
    expect(await fiscalRowsOf(validationA)).toHaveLength(1)
    expect(await fiscalRowsOf(validationB)).toHaveLength(1)
  })
})
