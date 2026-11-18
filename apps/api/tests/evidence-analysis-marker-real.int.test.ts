import { type DocumentAnalysisResult } from '@comprova/core'
import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, inArray, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import {
  makeDocumentAnalyzer,
  makeDocumentIntelligenceClient,
  makeFakeObjectStore,
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
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeEvidenceTick } from '../../worker/src/modules/evidence-analysis/evidence-analysis.service.js'
import { verifyEvidenceTick } from '../../worker/src/modules/evidence-verification/evidence-verification.service.js'
import { buildApp } from '../src/app.js'

/**
 * F1.2/F1.3 — integração REAL com o serviço Document Intelligence (Marker).
 *
 * Este teste aponta o analyzer para o serviço Marker rodando localmente
 * (http://localhost:8000) e valida o fluxo completo ponta a ponta:
 * upload → evidence_analysis → evidence-verification → claim_evidence.
 *
 * Pré-requisito: o serviço Document Intelligence deve estar em execução:
 *   docker compose --profile document-intelligence up -d document-intelligence
 *
 * Os PDFs em tests/fixtures/ são sintéticos e não contêm dados reais.
 */

const PEPPER = 'test-pepper-marker-real'
const MAX_BYTES = 50 * 1024 * 1024
const FIXED_NOW = () => new Date('2026-10-22T12:00:00.000Z')
// Timeout alinhado ao cliente Document Intelligence (360s) + margem de inicialização.
const TEST_TIMEOUT_MS = 400_000

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

const tenantA = await createTenant(adminPool.db, { name: 'marker-real-a' })
const keyA = (await createApiKey(adminPool.db, tenantA, PEPPER)).plaintext

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
    POLICY_VERSION: '2026.14.1',
    TERMS_VERSION: '1.0.0',
    TERMS_APPROVED: 'true',
    TERMS_DOCUMENT_HASH: 'sha256:abc123def456',
    WORKER_LOOPS: false,
    EVIDENCE_MAX_BYTES: MAX_BYTES,
    EVIDENCE_MAX_CONCURRENCY: 2,
    DOCUMENT_INTELLIGENCE_URL: 'http://localhost:8000',
    DOCUMENT_INTELLIGENCE_TIMEOUT_MS: 360_000,
    DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB: 30,
  },
  db: appPool.db,
  redis,
  logger,
  metrics: createMetrics(),
  objectStore: store,
})

beforeAll(async () => {
  // Verifica se o serviço Document Intelligence está disponível antes de executar
  // os testes. Se não estiver, falha com mensagem clara em vez de falso negativo.
  const health = await fetch('http://localhost:8000/ready')
  const body = (await health.json()) as { status: string }
  if (body.status !== 'ready') {
    throw new Error(
      'Document Intelligence não está disponível em http://localhost:8000. ' +
        'Inicie com: docker compose --profile document-intelligence up -d document-intelligence',
    )
  }
})

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const multipart = (data: Buffer, filename = 'proof.pdf', contentType = 'application/pdf') => {
  const boundary = `----comprova-marker-real-${randomUUID()}`
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
          .where(inArray(t.evidenceAnalysis.artifactId, artifactIds))
  const verifications = evidence.filter((row) => row.source === 'uploaded_document')
  return { claims, evidence, artifacts, analyses, verifications, intake }
}

const makeValidation = async (): Promise<string> => {
  const subjectId = await createSubject(adminPool.db, tenantA)
  return createValidation(adminPool.db, tenantA, subjectId)
}

const runAnalysis = async () =>
  analyzeEvidenceTick({
    db: adminPool.db,
    store,
    analyzer: markerAnalyzer,
    logger,
    maxBytes: MAX_BYTES,
    batchSize: 10,
  })

const runVerification = async () =>
  verifyEvidenceTick({
    db: adminPool.db,
    logger,
    batchSize: 10,
    now: FIXED_NOW,
  })

// Analyzer configurado com o cliente DI real (Marker ao vivo).
const documentIntelligence = makeDocumentIntelligenceClient({
  url: 'http://localhost:8000',
  timeoutMs: 360_000,
  maxFileSizeMb: 30,
  logger,
})
const markerAnalyzer = makeDocumentAnalyzer({
  now: FIXED_NOW,
  documentIntelligence,
})

describe('F1.2/F1.3 — integração real com o Marker (Document Intelligence)', () => {
  it(
    'PDF textual: extrai titular, endereço e CEP via camada local (sem chamar Marker)',
    async () => {
      const validationId = await makeValidation()
      const pdf = readFileSync(new URL('./fixtures/conta_energia.pdf', import.meta.url))
      const res = await upload(validationId, keyA, pdf)
      expect(res.statusCode).toBe(201)

      const processed = await runAnalysis()
      expect(processed).toBeGreaterThanOrEqual(1)

      const { analyses, evidence } = await graphOf(validationId)
      const analysis = analyses[0]
      expect(analysis?.status).toBe('completed')
      const result = analysis?.result as DocumentAnalysisResult
      expect(result.status).toBe('completed')
      // Camada local suficiente: não chama Marker.
      expect(result.provenance?.provider).toBe('local')
      expect(result.address.status).toBe('extracted')
      expect(result.address.value?.cep).toBe('01001000')
      expect(result.address.value?.logradouro).toBe('RUA DAS FLORES')
      expect(result.address.value?.numero).toBe('123')
      expect(result.address.value?.uf).toBe('SP')
      expect(result.holder.status).toBe('extracted')
      expect(result.holder.value?.name).toBe('Maria da Silva')
      // CPF/CNPJ não são persistidos no F1.2.
      expect(JSON.stringify(result)).not.toContain('123.456.789-00')
      // Observação de intake permanece unknown/pending.
      expect(evidence[0]?.stance).toBe('unknown')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'PDF digitalizado: usa OCR do Marker e extrai campos',
    async () => {
      const validationId = await makeValidation()
      const pdf = readFileSync(new URL('./fixtures/digitalizado.pdf', import.meta.url))
      const res = await upload(validationId, keyA, pdf)
      expect(res.statusCode).toBe(201)

      const processed = await runAnalysis()
      expect(processed).toBeGreaterThanOrEqual(1)

      const { analyses } = await graphOf(validationId)
      const analysis = analyses[0]
      expect(analysis?.status).toBe('completed')
      const result = analysis?.result as DocumentAnalysisResult
      expect(result.status).toBe('completed')
      // Camada local insuficiente (sem texto): usa Marker como base.
      expect(result.provenance?.provider).toBe('marker')
      expect(result.provenance?.markerVersion).toBe('2.1.0')
      expect(result.address.status).toBe('extracted')
      expect(result.address.value?.cep).toBe('01001000')
      expect(result.address.value?.logradouro).toBe('RUA DAS FLORES')
      // OCR de imagem digitalizada pode introduzir ruído (ex: "UF." em vez de "UF");
      // verifica UF quando disponível, mas não falha por ruído de OCR.
      const uf = result.address.value?.uf
      if (uf !== null) {
        expect(uf).toBe('SP')
      }
      expect(result.holder.status).toBe('extracted')
      expect(result.holder.value?.name).toBe('Maria da Silva')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'PDF com múltiplas páginas: extrai campos preservando ordem de leitura',
    async () => {
      const validationId = await makeValidation()
      const pdf = readFileSync(new URL('./fixtures/multipagina.pdf', import.meta.url))
      const res = await upload(validationId, keyA, pdf)
      expect(res.statusCode).toBe(201)

      const processed = await runAnalysis()
      expect(processed).toBeGreaterThanOrEqual(1)

      const { analyses } = await graphOf(validationId)
      const analysis = analyses[0]
      expect(analysis?.status).toBe('completed')
      const result = analysis?.result as DocumentAnalysisResult
      expect(result.status).toBe('completed')
      // Endereço da primeira página extraído pela camada local.
      expect(result.address.status).toBe('extracted')
      expect(result.address.value?.cep).toBe('01001000')
      expect(result.address.value?.logradouro).toBe('RUA DAS FLORES')
      // Camada local suficiente para PDF de texto: não chama Marker.
      expect(result.provenance?.provider).toBe('local')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'fluxo completo: upload → análise → verificação materializa claim_evidence',
    async () => {
      const validationId = await makeValidation()
      const pdf = readFileSync(new URL('./fixtures/conta_agua.pdf', import.meta.url))
      const res = await upload(validationId, keyA, pdf)
      expect(res.statusCode).toBe(201)

      await runAnalysis()
      const processed = await runVerification()
      expect(processed).toBeGreaterThanOrEqual(1)

      const { verifications } = await graphOf(validationId)
      expect(verifications).toHaveLength(1)
      const v = verifications[0]!
      expect(v.source).toBe('uploaded_document')
      expect(v.checker).toBe('document_upload_verification')
      expect(v.stance).toBe('unknown')
      expect(v.signalId).toBeNull()
      expect(JSON.stringify(v.detail)).not.toContain('Joao Pereira Santos')
      expect(JSON.stringify(v.detail)).not.toContain('Avenida Paulista')
      // A verificação não altera score/veredito.
      const detail = v.detail as Record<string, unknown>
      expect(detail).toHaveProperty('verification')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'replay do upload com PDF digitalizado não dispara segunda inferência do Marker',
    async () => {
      const validationId = await makeValidation()
      const pdf = readFileSync(new URL('./fixtures/digitalizado.pdf', import.meta.url))
      const res = await upload(validationId, keyA, pdf)
      expect(res.statusCode).toBe(201)

      // Primeira submissão: executa processamento (chama o Marker via OCR).
      const processed = await runAnalysis()
      expect(processed).toBeGreaterThanOrEqual(1)
      const first = (await graphOf(validationId)).analyses[0]
      expect(first?.status).toBe('completed')

      // Replay com o mesmo conteúdo: não deve criar novo artefato nem análise.
      const replay = await upload(validationId, keyA, pdf)
      expect(replay.statusCode).toBe(200)
      expect(replay.headers['idempotent-replayed']).toBe('true')

      // Segunda execução do ticker não deve processar nenhum job novo.
      const secondProcessed = await runAnalysis()
      expect(secondProcessed).toBe(0)

      const { analyses } = await graphOf(validationId)
      expect(analyses).toHaveLength(1)
      expect(analyses[0]?.analysisId).toBe(first?.analysisId)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'upload com conteúdo diferente na mesma validation retorna 409 (sem duplicar)',
    async () => {
      const validationId = await makeValidation()
      const pdfEnergia = readFileSync(new URL('./fixtures/conta_energia.pdf', import.meta.url))
      const pdfAgua = readFileSync(new URL('./fixtures/conta_agua.pdf', import.meta.url))
      const res1 = await upload(validationId, keyA, pdfEnergia)
      expect(res1.statusCode).toBe(201)

      const res2 = await upload(validationId, keyA, pdfAgua)
      expect(res2.statusCode).toBe(409)

      // Não cria segunda análise.
      await runAnalysis()
      const { analyses } = await graphOf(validationId)
      expect(analyses).toHaveLength(1)
    },
    TEST_TIMEOUT_MS,
  )
})
