import {
  FISCAL_VERIFICATION_CONTRACT_VERSION,
  fiscalCheckerVersion,
  fiscalDocumentFingerprint,
  toFiscalLookupInput,
  type FiscalAdapter,
  type FiscalLookupInput,
  type FiscalVerificationResult,
} from '@comprova/core'
import { and, createDbPool, eq, inArray, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import {
  extractFiscalReference,
  makeFakeFiscalAdapter,
  makeFiscalEndpointAllowlist,
  makeNf3eFiscalAdapter,
} from '@comprova/providers'
import {
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSafeExternalFetch } from '../../../packages/providers/src/safe-fetch/index.js'
import { verifyFiscalClaim } from '../../worker/src/modules/fiscal-verification/fiscal-verification.service.js'

const FIXED_NOW = new Date('2026-10-23T12:00:00.000Z')
const CNPJ_BASICO = '12345678'
const MUNICIPIO_IBGE = 3550308
const DOCUMENT_ID = '35261012345678000199660010000000011000000010'
const QR_URL = 'https://169.254.169.254/latest/meta-data/iam/security-credentials/?token=qr-secret'
const ARTIFACT_SHA256 = 'ab'.repeat(32)
const RS_MUNICIPIO_IBGE = 4314902
const RS_DOCUMENT_ID = '43191212345678000199660000000000101018342413'
const RS_QR_URL = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNF3e=${RS_DOCUMENT_ID}&tpAmb=1`
const SVRS_FIXTURE_MINIMAL = readFileSync(
  new URL(
    '../../../packages/providers/src/fiscal/__fixtures__/nf3e-svrs-found-minimal.html',
    import.meta.url,
  ),
  'utf8',
)
const SVRS_FIXTURE_FULL = readFileSync(
  new URL('../../../packages/providers/src/fiscal/__fixtures__/nf3e-svrs-found-full.html', import.meta.url),
  'utf8',
)

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const appPool = createDbPool(db.appUrl)

const logLines: string[] = []
const logger = createLogger({
  level: 'debug',
  stream: { write: (line) => logLines.push(line) },
})

const tenantA = await createTenant(adminPool.db, { name: 'fiscal-a' })
const tenantB = await createTenant(adminPool.db, { name: 'fiscal-b' })

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
  .values([
    {
      codigoReceita: 3550308,
      codigoIbge: MUNICIPIO_IBGE,
      nomeNorm: 'SAO PAULO',
      uf: 'SP',
    },
    {
      codigoReceita: RS_MUNICIPIO_IBGE,
      codigoIbge: RS_MUNICIPIO_IBGE,
      nomeNorm: 'PORTO ALEGRE',
      uf: 'RS',
    },
  ])
  .onConflictDoNothing()

afterAll(async () => {
  await adminPool.end()
  await appPool.end()
  await db.stop()
})

interface ClaimFixture {
  readonly tenantId: string
  readonly claimId: string
  readonly validationId: string
  readonly subjectId: string
  readonly addressId: string
}

interface ClaimOverrides {
  readonly numero?: string
  readonly cep?: string
  readonly uf?: string
  readonly municipioIbge?: number
  readonly logradouroNorm?: string
  readonly bairroNorm?: string
}

const makeClaim = async (tenantId: string, overrides: ClaimOverrides = {}): Promise<ClaimFixture> => {
  const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
  const validationId = await createValidation(adminPool.db, tenantId, subjectId)
  const addressId = randomUUID()

  await adminPool.db.insert(t.canonicalAddress).values({
    addressId,
    buildingKey: randomBytes(32),
    countryCode: 'BR',
    uf: overrides.uf ?? 'SP',
    municipioIbge: overrides.municipioIbge ?? MUNICIPIO_IBGE,
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

  const claimId = randomUUID()
  await adminPool.db.insert(t.claim).values({
    claimId,
    tenantId,
    validationId,
    subjectId,
    addressId,
    type: 'business_registered_address',
    subjectType: 'organization',
    targetType: 'address',
  })

  return { tenantId, claimId, validationId, subjectId, addressId }
}

const inputFor = (claim: ClaimFixture, overrides: Partial<FiscalLookupInput> = {}): FiscalLookupInput => ({
  source: 'nf3e',
  tenantId: claim.tenantId,
  claimId: claim.claimId,
  documentId: DOCUMENT_ID,
  qrCodeUrl: QR_URL,
  issuer: 'SVRS',
  uf: 'SP',
  artifact: { artifactId: randomUUID(), sha256: ARTIFACT_SHA256 },
  ...overrides,
})

const run = async (
  adapter: FiscalAdapter,
  input: FiscalLookupInput,
  now: Date = FIXED_NOW,
): Promise<string> =>
  verifyFiscalClaim(
    {
      db: adminPool.db,
      adapter,
      logger,
      now: () => now,
    },
    input,
  )

const fiscalRowsOf = async (claimId: string) => {
  const rows = await adminPool.db
    .select()
    .from(t.claimEvidence)
    .where(
      and(
        eq(t.claimEvidence.claimId, claimId),
        inArray(t.claimEvidence.source, ['fiscal_nf3e', 'fiscal_nfag']),
      ),
    )
  return rows
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
  readonly document_ref_hash: string
  readonly adapter_version: string
  readonly contract_version: string
  readonly observed_at: string
  readonly issued_at: string | null
  readonly limitations: readonly string[]
  readonly error_codes: readonly string[]
  readonly audit: {
    readonly requested_url_sha256: string | null
    readonly resolved_ip: string | null
    readonly response_status: number | null
    readonly response_sha256: string | null
  }
  readonly query: {
    readonly uf: string | null
    readonly qr_present: boolean
  }
}

const verificationOf = (
  row: { readonly detail: Record<string, unknown> } | undefined,
): PersistedVerification => {
  const value = row?.detail.verification
  if (value === null || typeof value !== 'object') throw new Error('fiscal verification detail missing')
  return value as PersistedVerification
}

describe('F2.1 — contrato e materialização de fonte fiscal', () => {
  it('materializa documento, endereço e titular sem signal e sem resposta/PII bruta', async () => {
    const claim = await makeClaim(tenantA)
    const input = inputFor(claim)
    const requestedUrl = 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chave=secret'
    const adapter = makeFakeFiscalAdapter({
      version: '1.0.0',
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      issuer: 'SVRS',
      environment: 'production',
      audit: {
        requestedUrl,
        resolvedIp: '203.0.113.10',
        responseStatus: 200,
        responseSha256: 'cd'.repeat(32),
      },
    })
    const before = logLines.length

    await expect(run(adapter, input)).resolves.toBe('inserted')

    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      tenantId: tenantA,
      source: 'fiscal_nf3e',
      checker: 'nf3e_verification',
      checkerVersion: fiscalCheckerVersion('1.0.0', input, {
        adapterSource: 'nf3e',
        documentOutcome: 'authentic',
      }),
      stance: 'supports',
      strength: 0,
      confidence: 0,
      signalId: null,
    })
    expect(Buffer.from(row?.evidenceSha256 as Buffer).toString('hex')).toBe(ARTIFACT_SHA256)

    const verification = verificationOf(row)
    expect(verification).toMatchObject({
      status: 'completed',
      method: 'official_qr_consultation',
      source: {
        kind: 'fiscal_nf3e',
        id: 'nf3e',
        authority: 'SVRS',
        environment: 'production',
      },
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      document_ref_hash: fiscalDocumentFingerprint(input),
      adapter_version: '1.0.0',
      contract_version: FISCAL_VERIFICATION_CONTRACT_VERSION,
      observed_at: FIXED_NOW.toISOString(),
      issued_at: null,
      audit: {
        requested_url_sha256: createHash('sha256').update(requestedUrl).digest('hex'),
        resolved_ip: '203.0.113.10',
        response_status: 200,
        response_sha256: 'cd'.repeat(32),
      },
      query: { uf: 'SP', qr_present: true },
    })

    const serialized = JSON.stringify(row?.detail)
    expect(serialized).not.toContain(DOCUMENT_ID)
    expect(serialized).not.toContain('qr-secret')
    expect(serialized).not.toContain('169.254.169.254')
    expect(serialized).not.toContain('trust_score')
    expect(serialized).not.toContain('approved')

    const signals = await adminPool.db
      .select({ signalId: t.signal.signalId })
      .from(t.signal)
      .where(eq(t.signal.validationId, claim.validationId))
    expect(signals).toEqual([])

    const newLogs = logLines.slice(before).join('\n')
    expect(newLogs).not.toContain(DOCUMENT_ID)
    expect(newLogs).not.toContain('qr-secret')
    expect(newLogs).not.toContain('Empresa Exemplo')
  })

  it('remove campos de scoring/veredito emitidos indevidamente pelo adapter', async () => {
    const claim = await makeClaim(tenantA)
    const input = inputFor(claim)
    const base = makeFakeFiscalAdapter({ document: 'authentic', address: 'matches', holder: 'matches' })
    const adapter: FiscalAdapter = {
      ...base,
      verify: async (lookup, context) =>
        ({
          ...(await base.verify(lookup, context)),
          trust_score: 0.99,
          final_score: 1,
          approved: true,
          rejected: false,
        }) as FiscalVerificationResult,
    }

    await expect(run(adapter, input)).resolves.toBe('inserted')
    const serialized = JSON.stringify((await fiscalRowsOf(claim.claimId))[0]?.detail)
    expect(serialized).not.toContain('trust_score')
    expect(serialized).not.toContain('final_score')
    expect(serialized).not.toContain('approved')
    expect(serialized).not.toContain('rejected')
  })

  it.each([
    { document: 'invalid', status: 'invalid' },
    { document: 'not_found', status: 'completed' },
    { document: 'unavailable', status: 'unavailable' },
    { document: 'inconclusive', status: 'inconclusive' },
    { document: 'unsupported', status: 'unsupported' },
  ] as const)('preserva $document e mantém stance unknown', async ({ document, status }) => {
    const claim = await makeClaim(tenantA)
    const adapter = makeFakeFiscalAdapter({
      document,
      address: 'not_extracted',
      holder: 'not_extracted',
    })

    await expect(run(adapter, inputFor(claim))).resolves.toBe('inserted')

    const row = (await fiscalRowsOf(claim.claimId))[0]
    expect(row?.stance).toBe('unknown')
    expect(verificationOf(row)).toMatchObject({
      status,
      document,
      address: 'not_extracted',
      holder: 'not_extracted',
    })
  })

  it('mantém endereço e titular independentes', async () => {
    const addressClaim = await makeClaim(tenantA, { numero: '999' })
    const addressAdapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'differs',
      holder: 'matches',
    })
    await run(addressAdapter, inputFor(addressClaim))
    const addressRow = (await fiscalRowsOf(addressClaim.claimId))[0]
    expect(addressRow?.stance).toBe('contradicts')
    expect(verificationOf(addressRow)).toMatchObject({
      document: 'authentic',
      address: 'differs',
      holder: 'matches',
    })

    const holderClaim = await makeClaim(tenantA)
    const holderAdapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'matches',
      holder: 'not_extracted',
    })
    await run(holderAdapter, inputFor(holderClaim))
    const holderRow = (await fiscalRowsOf(holderClaim.claimId))[0]
    expect(holderRow?.stance).toBe('supports')
    expect(verificationOf(holderRow)).toMatchObject({
      document: 'authentic',
      address: 'matches',
      holder: 'not_extracted',
    })

    const holderDiffersClaim = await makeClaim(tenantA)
    const holderDiffersAdapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'matches',
      holder: 'differs',
    })
    await run(holderDiffersAdapter, inputFor(holderDiffersClaim))
    const holderDiffersRow = (await fiscalRowsOf(holderDiffersClaim.claimId))[0]
    expect(holderDiffersRow?.stance).toBe('unknown')
    expect(verificationOf(holderDiffersRow)).toMatchObject({
      document: 'authentic',
      address: 'matches',
      holder: 'differs',
    })

    const noAddressClaim = await makeClaim(tenantA)
    const noAddressAdapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'not_extracted',
      holder: 'matches',
    })
    await run(noAddressAdapter, inputFor(noAddressClaim))
    const noAddressRow = (await fiscalRowsOf(noAddressClaim.claimId))[0]
    expect(noAddressRow?.stance).toBe('unknown')
    expect(verificationOf(noAddressRow)).toMatchObject({
      document: 'authentic',
      address: 'not_extracted',
      holder: 'matches',
    })
  })

  it('mapeia source não suportada para unsupported sem chamar verify', async () => {
    const claim = await makeClaim(tenantA)
    const verify = vi.fn()
    const nf3eAdapter: FiscalAdapter = {
      source: 'nf3e',
      version: '1.0.0',
      supports: () => false,
      verify,
    }
    const before = logLines.length

    await expect(run(nf3eAdapter, inputFor(claim, { source: 'nfag-e' }))).resolves.toBe('inserted')

    const row = (await fiscalRowsOf(claim.claimId))[0]
    expect(row).toMatchObject({ source: 'fiscal_nfag', checker: 'nfag-e_verification', stance: 'unknown' })
    expect(verificationOf(row)).toMatchObject({
      status: 'unsupported',
      document: 'unsupported',
      source: { kind: 'fiscal_nfag', id: 'nfag-e' },
    })
    expect(verify).not.toHaveBeenCalled()

    // O motivo explícito precisa estar no log para diagnóstico no Kibana.
    const newLogs = logLines.slice(before).join('\n')
    expect(newLogs).toContain('SOURCE_NOT_SUPPORTED')
    expect(newLogs).toContain('fiscal source not supported by adapter')
    expect(newLogs).toContain(claim.claimId)
    expect(newLogs).toContain('"source":"nfag-e"')
  })

  it('trata timeout/erro do adapter como unavailable, nunca invalid', async () => {
    const timeoutClaim = await makeClaim(tenantA)
    const timeoutAdapter = makeFakeFiscalAdapter({ unavailableReason: 'SEFAZ_TIMEOUT' })
    await expect(run(timeoutAdapter, inputFor(timeoutClaim))).resolves.toBe('inserted')
    const timeoutRow = (await fiscalRowsOf(timeoutClaim.claimId))[0]
    expect(timeoutRow?.stance).toBe('unknown')
    expect(verificationOf(timeoutRow)).toMatchObject({
      status: 'unavailable',
      document: 'unavailable',
      limitations: ['SEFAZ_TIMEOUT'],
      error_codes: ['SEFAZ_TIMEOUT'],
    })

    const failureClaim = await makeClaim(tenantA)
    const failureAdapter = makeFakeFiscalAdapter({ failure: 'boom' })
    await expect(run(failureAdapter, inputFor(failureClaim))).resolves.toBe('inserted')
    const failureRow = (await fiscalRowsOf(failureClaim.claimId))[0]
    expect(failureRow?.stance).toBe('unknown')
    expect(verificationOf(failureRow)).toMatchObject({
      status: 'unavailable',
      document: 'unavailable',
      error_codes: ['ADAPTER_ERROR'],
    })
  })

  it('não deixa unavailable bloquear um resultado terminal posterior', async () => {
    const claim = await makeClaim(tenantA)
    const input = inputFor(claim)
    const unavailable = makeFakeFiscalAdapter({
      version: '1.0.0',
      unavailableReason: 'SEFAZ_TIMEOUT',
    })
    const success = makeFakeFiscalAdapter({
      version: '1.0.0',
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
    })

    await expect(run(unavailable, input)).resolves.toBe('inserted')
    await expect(run(success, input)).resolves.toBe('inserted')

    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => verificationOf(row).document).sort()).toEqual(['authentic', 'unavailable'])
    const terminal = rows.find((row) => verificationOf(row).document === 'authentic')
    expect(terminal?.stance).toBe('supports')
  })

  it('rejeita resultado de adapter com documento diferente do input', async () => {
    const claim = await makeClaim(tenantA)
    const adapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      documentId: 'outro-documento',
    })

    await expect(run(adapter, inputFor(claim))).resolves.toBe('inserted')

    const row = (await fiscalRowsOf(claim.claimId))[0]
    expect(row?.stance).toBe('unknown')
    expect(verificationOf(row)).toMatchObject({
      status: 'unavailable',
      document: 'unavailable',
      error_codes: ['ADAPTER_RESULT_DOCUMENT_MISMATCH'],
    })
  })

  it('sanitiza reason codes desconhecidos antes de persistir', async () => {
    const claim = await makeClaim(tenantA)
    const adapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      limitations: ['CPF_12345678900'],
      errorCodes: ['SECRET_TOKEN'],
    })

    await expect(run(adapter, inputFor(claim))).resolves.toBe('inserted')

    const row = (await fiscalRowsOf(claim.claimId))[0]
    expect(verificationOf(row)).toMatchObject({
      limitations: ['ADAPTER_ERROR'],
      error_codes: ['ADAPTER_ERROR'],
    })
    expect(JSON.stringify(row?.detail)).not.toContain('CPF_12345678900')
    expect(JSON.stringify(row?.detail)).not.toContain('SECRET_TOKEN')
  })

  it('não colide unsupported de um adapter com o adapter real da fonte', async () => {
    const claim = await makeClaim(tenantA)
    const input = inputFor(claim, { source: 'nfag-e' })
    const nf3eAdapter = makeFakeFiscalAdapter({ source: 'nf3e', version: '1.0.0' })
    const nfagAdapter = makeFakeFiscalAdapter({
      source: 'nfag-e',
      version: '1.0.0',
      document: 'unsupported',
    })

    await expect(run(nf3eAdapter, input)).resolves.toBe('inserted')
    await expect(run(nfagAdapter, input)).resolves.toBe('inserted')

    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => verificationOf(row).document === 'unsupported')).toBe(true)
  })

  it('não duplica a mesma consulta e diferencia documentos/versões', async () => {
    const claim = await makeClaim(tenantA)
    const input = inputFor(claim)
    const adapterV1 = makeFakeFiscalAdapter({ version: '1.0.0' })

    await expect(run(adapterV1, input)).resolves.toBe('inserted')
    await expect(run(adapterV1, input)).resolves.toBe('duplicate')
    expect(await fiscalRowsOf(claim.claimId)).toHaveLength(1)

    await expect(run(adapterV1, inputFor(claim, { documentId: 'outro-documento' }))).resolves.toBe('inserted')
    expect(await fiscalRowsOf(claim.claimId)).toHaveLength(2)

    const adapterV2 = makeFakeFiscalAdapter({ version: '1.1.0' })
    await expect(run(adapterV2, input, new Date('2026-10-23T13:00:00.000Z'))).resolves.toBe('inserted')

    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(3)
    const versions = rows.map((row) => verificationOf(row).adapter_version).sort()
    expect(versions).toEqual(['1.0.0', '1.0.0', '1.1.0'])
    const v1 = rows.find(
      (row) =>
        verificationOf(row).adapter_version === '1.0.0' && verificationOf(row).document === 'authentic',
    )
    expect(verificationOf(v1).observed_at).toBe(FIXED_NOW.toISOString())
  })

  it('não materializa em claim de outro tenant', async () => {
    const claimB = await makeClaim(tenantB)
    const inputAWithClaimB = inputFor({ ...claimB, tenantId: tenantA })
    const adapter = makeFakeFiscalAdapter({ document: 'authentic', address: 'matches', holder: 'matches' })

    await expect(run(adapter, inputAWithClaimB)).resolves.toBe('skipped')
    expect(await fiscalRowsOf(claimB.claimId)).toHaveLength(0)

    const visibleToA = await withTenant(appPool.db, tenantA, (tx) =>
      tx
        .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimId, claimB.claimId)),
    )
    expect(visibleToA).toEqual([])

    await expect(run(adapter, inputFor(claimB))).resolves.toBe('inserted')
    const rowsB = await fiscalRowsOf(claimB.claimId)
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0]?.tenantId).toBe(tenantB)
  })
})

describe('F2.2a — da referência extraída à observação fiscal', () => {
  const NF3E_ACCESS_KEY = '35261012345678000199660010000000011000000015'
  const NF3E_QR = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_ACCESS_KEY}&nVersao=4&tpAmb=1`

  it('extrai a referência do payload e materializa com o FakeFiscalAdapter', async () => {
    const claim = await makeClaim(tenantA)
    const artifact = { artifactId: randomUUID(), sha256: ARTIFACT_SHA256 }
    const reference = extractFiscalReference({ value: NF3E_QR, method: 'qr_code' })

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_ACCESS_KEY,
    })

    const lookup = toFiscalLookupInput(reference, {
      tenantId: claim.tenantId,
      claimId: claim.claimId,
      artifact,
    })
    if (lookup === null) throw new Error('referência NF3e deveria produzir FiscalLookupInput')

    const adapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
    })
    await expect(run(adapter, lookup)).resolves.toBe('inserted')
    // A mesma referência normalizada não duplica a observação.
    await expect(run(adapter, lookup)).resolves.toBe('duplicate')

    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'fiscal_nf3e',
      checker: 'nf3e_verification',
      stance: 'supports',
    })
    expect(verificationOf(rows[0])).toMatchObject({
      document: 'authentic',
      document_ref_hash: fiscalDocumentFingerprint(lookup),
    })
    expect(Buffer.from(rows[0]?.evidenceSha256 as Buffer).toString('hex')).toBe(ARTIFACT_SHA256)
  })

  it('não deixa a referência atravessar o tenant do contexto confiável', async () => {
    const claimB = await makeClaim(tenantB)
    const reference = extractFiscalReference({ value: NF3E_QR, method: 'qr_code' })
    const adapter = makeFakeFiscalAdapter({
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
    })

    // Contexto de tenant A com claim de tenant B: a referência não pode
    // "arrastar" o claim. A materialização retorna skipped.
    const spoofed = toFiscalLookupInput(reference, {
      tenantId: tenantA,
      claimId: claimB.claimId,
      artifact: null,
    })
    if (spoofed === null) throw new Error('referência NF3e deveria produzir FiscalLookupInput')
    await expect(run(adapter, spoofed)).resolves.toBe('skipped')
    expect(await fiscalRowsOf(claimB.claimId)).toHaveLength(0)

    const legitimate = toFiscalLookupInput(reference, {
      tenantId: claimB.tenantId,
      claimId: claimB.claimId,
      artifact: null,
    })
    if (legitimate === null) throw new Error('referência NF3e deveria produzir FiscalLookupInput')
    await expect(run(adapter, legitimate)).resolves.toBe('inserted')
    const rowsB = await fiscalRowsOf(claimB.claimId)
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0]?.tenantId).toBe(tenantB)
  })

  it('referência não reconhecida não gera consulta nem evidência', () => {
    const reference = extractFiscalReference({ value: 'https://evil.example/comprovante.pdf' })
    expect(reference.status).toBe('unsupported')
    expect(
      toFiscalLookupInput(reference, { tenantId: tenantA, claimId: randomUUID(), artifact: null }),
    ).toBeNull()
  })
})

describe('F2.2b — primeira consulta real NF3e/SVRS', () => {
  const LOCAL_ALLOWLIST = makeFiscalEndpointAllowlist([
    {
      source: 'nf3e',
      issuer: 'SVRS',
      environment: 'local',
      url: 'https://fiscal.test/nf3e/qrCode',
    },
  ])

  const requests: { method: string; url: string; body: string }[] = []
  let server: Server
  let port = 0

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (request.method !== 'POST' || request.url !== '/nf3e/qrCode') {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('not found')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(SVRS_FIXTURE_MINIMAL)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  })

  beforeEach(() => {
    requests.length = 0
  })

  const localSafeFetch = () =>
    createSafeExternalFetch({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: (options) => {
        const {
          protocol: _protocol,
          hostname: _hostname,
          port: _port,
          lookup: _lookup,
          servername: _servername,
          ...rest
        } = options
        void _protocol
        void _hostname
        void _port
        void _lookup
        void _servername
        return httpRequest({ ...rest, protocol: 'http:', hostname: '127.0.0.1', port })
      },
    })

  const localAdapter = (version = '1.0.0') =>
    makeNf3eFiscalAdapter({
      version,
      environment: 'local',
      allowlist: LOCAL_ALLOWLIST,
      safeFetch: localSafeFetch(),
    })

  const rsClaim = (tenantId: string, overrides: ClaimOverrides = {}) =>
    makeClaim(tenantId, {
      uf: 'RS',
      municipioIbge: RS_MUNICIPIO_IBGE,
      cep: '90010150',
      logradouroNorm: 'RUA DAS FLORES',
      numero: '123',
      bairroNorm: 'CENTRO',
      ...overrides,
    })

  const rsInput = (claim: ClaimFixture): FiscalLookupInput => {
    const reference = extractFiscalReference({ value: RS_QR_URL, method: 'qr_code' })
    const input = toFiscalLookupInput(reference, {
      tenantId: claim.tenantId,
      claimId: claim.claimId,
      artifact: { artifactId: randomUUID(), sha256: ARTIFACT_SHA256 },
    })
    if (input === null) throw new Error('QR SVRS deveria produzir FiscalLookupInput')
    return input
  }

  it('executa a consulta pela guarda de fetch e materializa a fixture observada', async () => {
    const claim = await rsClaim(tenantA)
    const input = rsInput(claim)
    const before = logLines.length

    await expect(run(localAdapter(), input)).resolves.toBe('inserted')

    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request).toMatchObject({ method: 'POST', url: '/nf3e/qrCode' })
    const body = new URLSearchParams(request?.body ?? '')
    expect(body.get('pesq.Sistema')).toBe('Nf3e')
    expect(body.get('pesq.tpAmb')).toBe('2')
    expect(body.get('pesq.chBpe')).toBe(RS_DOCUMENT_ID)
    expect(body.get('pesq.chCte')).toBe(RS_DOCUMENT_ID)
    expect(body.get('pesq.chMdfe')).toBe(RS_DOCUMENT_ID)

    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      tenantId: tenantA,
      source: 'fiscal_nf3e',
      checker: 'nf3e_verification',
      stance: 'unknown',
      strength: 0,
      confidence: 0,
      signalId: null,
    })

    const verification = verificationOf(row)
    expect(verification).toMatchObject({
      status: 'completed',
      method: 'official_qr_consultation',
      source: {
        kind: 'fiscal_nf3e',
        id: 'nf3e',
        authority: 'SVRS',
        environment: 'local',
      },
      document: 'authentic',
      address: 'not_extracted',
      holder: 'not_extracted',
      document_ref_hash: fiscalDocumentFingerprint(input),
      adapter_version: '1.0.0',
      contract_version: FISCAL_VERIFICATION_CONTRACT_VERSION,
      observed_at: FIXED_NOW.toISOString(),
      issued_at: null,
      limitations: [],
      error_codes: [],
      audit: {
        requested_url_sha256: sha256('https://fiscal.test/nf3e/qrCode'),
        resolved_ip: '8.8.8.8',
        response_status: 200,
        response_sha256: sha256(SVRS_FIXTURE_MINIMAL),
      },
      query: { uf: 'RS', qr_present: true },
    })

    const serialized = JSON.stringify(row?.detail)
    expect(serialized).not.toContain(RS_DOCUMENT_ID)
    expect(serialized).not.toContain('Porto Alegre')
    expect(serialized).not.toContain('Empresa Exemplo')
    expect(serialized).not.toContain('12.345.678/0001-99')
    expect(serialized).not.toContain('<div')
    expect(serialized).not.toContain('trust_score')
    expect(serialized).not.toContain('approved')

    const newLogs = logLines.slice(before).join('\n')
    expect(newLogs).not.toContain(RS_DOCUMENT_ID)
    expect(newLogs).not.toContain('Porto Alegre')
    expect(newLogs).not.toContain('Empresa Exemplo')

    const signals = await adminPool.db
      .select({ signalId: t.signal.signalId })
      .from(t.signal)
      .where(eq(t.signal.validationId, claim.validationId))
    expect(signals).toEqual([])
  })

  it('não duplica a mesma consulta e preserva histórico por versão do adapter', async () => {
    const claim = await rsClaim(tenantA)
    const input = rsInput(claim)

    await expect(run(localAdapter('1.0.0'), input)).resolves.toBe('inserted')
    await expect(run(localAdapter('1.0.0'), input)).resolves.toBe('duplicate')
    expect(await fiscalRowsOf(claim.claimId)).toHaveLength(1)

    await expect(run(localAdapter('1.0.1'), input)).resolves.toBe('inserted')
    const rows = await fiscalRowsOf(claim.claimId)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => verificationOf(row).adapter_version).sort()).toEqual(['1.0.0', '1.0.1'])
  })

  it('não materializa consulta real em claim de outro tenant', async () => {
    const claimB = await rsClaim(tenantB)
    const spoofed = rsInput({ ...claimB, tenantId: tenantA })

    await expect(run(localAdapter(), spoofed)).resolves.toBe('skipped')
    expect(await fiscalRowsOf(claimB.claimId)).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })

  it('reutiliza as comparações quando a fixture estendida traz endereço/titular', async () => {
    const claim = await rsClaim(tenantA)
    const input = rsInput(claim)
    const adapter = makeNf3eFiscalAdapter({
      environment: 'local',
      allowlist: LOCAL_ALLOWLIST,
      safeFetch: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from(SVRS_FIXTURE_FULL),
        address: '203.0.113.10',
      }),
    })

    await expect(run(adapter, input)).resolves.toBe('inserted')

    const row = (await fiscalRowsOf(claim.claimId))[0]
    expect(row?.stance).toBe('supports')
    expect(verificationOf(row)).toMatchObject({
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      limitations: [],
      error_codes: [],
    })
    const serialized = JSON.stringify(row?.detail)
    expect(serialized).not.toContain('Empresa Exemplo')
    expect(serialized).not.toContain('Rua das Flores')
    expect(serialized).not.toContain('90010-150')
  })
})
