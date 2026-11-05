import { createLogger, createMetrics } from '@comprova/observability'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { sha256Of, type ObjectStore } from '@comprova/providers'
import {
  createApiKey,
  createTenant,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { API_SCOPES } from '../src/plugins/scope.js'

const PEPPER = 'test-pepper-me-debug'
const MAX_BYTES = 10 * 1024 * 1024

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

class TestObjectStore implements ObjectStore {
  readonly objects = new Map<string, { readonly data: Buffer; readonly contentType: string }>()

  async put(key: string, data: Uint8Array, contentType: string) {
    const bytes = Buffer.from(data)
    this.objects.set(key, { data: bytes, contentType })
    return { key, uri: `test://${key}`, sha256: sha256Of(data), bytes: data.byteLength }
  }

  async delete(_key: string) {}
}

const store = new TestObjectStore()
const logger = createLogger({ level: 'silent' })

const tenantA = await createTenant(adminPool.db, { name: 'me-debug-a' })
const adminKey = (
  await createApiKey(adminPool.db, tenantA, PEPPER, {
    scopes: [API_SCOPES.validateWrite],
  })
).plaintext
const readOnlyKey = (
  await createApiKey(adminPool.db, tenantA, PEPPER, {
    scopes: [API_SCOPES.validateRead],
  })
).plaintext

// Define o usuário da sessão como admin via banco (simula o usuário logado)
await adminPool.db.update(t.authUser).set({ role: 'admin' }).where(eq(t.authUser.id, 'admin-user-id'))

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
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.11.1',
    TERMS_VERSION: '1.0.0',
    TERMS_APPROVED: 'true',
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

const auth = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` })

const escapePdf = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

/** PDF mínimo válido, com xref e fonte WinAnsi, para exercitar o analyzer real. */
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

const multipart = (pdf: Buffer): { readonly body: Buffer; readonly contentType: string } => {
  const boundary = '----comprova-test'
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('GET /v1/me', () => {
  it('retorna os dados da sessão com role (200)', async () => {
    // Simula um request com sessionUser definido via middleware de sessão.
    // Como o teste não tem cookie de better-auth, o sessionUser será undefined
    // e a rota deve retornar 401.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(adminKey),
    })
    expect(res.statusCode).toBe(401)
  })

  it('requer API key válida (401 sem chave)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /v1/debug/nf3e/qrcode', () => {
  it('requer API key válida (401 sem chave)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
    })
    expect(res.statusCode).toBe(401)
  })

  it('requer scope validate:write (403 com validate:read)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
    const boundary = '----comprova-test'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
      headers: {
        ...auth(readOnlyKey),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    })
    expect(res.statusCode).toBe(403)
  })

  it('aceita upload de PDF com validate:write (200)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
    const boundary = '----comprova-test'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
      headers: {
        ...auth(adminKey),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json.events)).toBe(true)
    expect(json.reference).toBeDefined()
    expect(json.reference.status).toBe('inconclusive') // PDF sem QR -> inconclusive
    expect(json.analysis).not.toBeNull()
    expect(json.analysis.holder.status).toBe('unknown')
    expect(json.analysis.address.status).toBe('unknown')
  })

  it('extrai titular e endereço do PDF (200)', async () => {
    const { body, contentType } = multipart(
      pdfWithText([
        'DANF3E - DOCUMENTO AUXILIAR',
        'ENDEREÇO DE ENTREGA:',
        'EMPRESA EXEMPLO LTDA',
        'RUA DAS FLORES 123',
        'CENTRO / SAO PAULO - SP',
        'CEP: 01001-000 MEDIDOR:0013681013',
        'Pagador: EMPRESA EXEMPLO LTDA CNPJ: 11.222.333/0001-81',
      ]),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
      headers: { ...auth(adminKey), 'content-type': contentType },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.analysis.holder).toMatchObject({
      status: 'extracted',
      value: { name: 'EMPRESA EXEMPLO LTDA' },
    })
    expect(json.analysis.address).toMatchObject({
      status: 'extracted',
      value: {
        logradouro: 'RUA DAS FLORES',
        numero: '123',
        bairro: 'CENTRO',
        cidade: 'SAO PAULO',
        uf: 'SP',
        cep: '01001000',
      },
    })
    const codes = json.events.map((event: { code: string }) => event.code)
    expect(codes).toContain('HOLDER_EXTRACTED')
    expect(codes).toContain('ADDRESS_EXTRACTED')
    expect(JSON.stringify(json)).not.toContain('11222333000181')
  })

  it('extrai titular e endereço de bloco estrutural sem rótulo (Light/RJ)', async () => {
    const { body, contentType } = multipart(
      pdfWithText([
        'DANF3E - DOCUMENTO AUXILIAR DA NOTA',
        'FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA',
        'JOAO DA SILVA',
        'R ALM GRENFALL 405 BL 1 LJ 4',
        'VILA SAO LUIS / DUQUE DE CAXIAS, RJ',
        'CEP 25085-135 | MEDIDOR: 6018930',
        'CPF 077.333.417-36',
      ]),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/nf3e/qrcode',
      headers: { ...auth(adminKey), 'content-type': contentType },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.analysis.holder).toMatchObject({
      status: 'extracted',
      value: { name: 'JOAO DA SILVA' },
    })
    expect(json.analysis.address).toMatchObject({
      status: 'extracted',
      value: {
        logradouro: 'RUA ALM GRENFALL',
        numero: '405',
        complemento: 'BL 1 LJ 4',
        bairro: 'VILA SAO LUIS',
        cidade: 'DUQUE DE CAXIAS',
        uf: 'RJ',
        cep: '25085135',
      },
    })
    expect(JSON.stringify(json)).not.toContain('077.333.417-36')
  })
})
