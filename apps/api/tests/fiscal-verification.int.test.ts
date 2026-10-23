import {
  FISCAL_VERIFICATION_CONTRACT_VERSION,
  fiscalCheckerVersion,
  fiscalDocumentFingerprint,
  type FiscalAdapter,
  type FiscalLookupInput,
  type FiscalVerificationResult,
} from '@comprova/core'
import { and, createDbPool, eq, inArray, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { makeFakeFiscalAdapter } from '@comprova/providers'
import {
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { verifyFiscalClaim } from '../../worker/src/modules/fiscal-verification/fiscal-verification.service.js'

const FIXED_NOW = new Date('2026-10-23T12:00:00.000Z')
const CNPJ_BASICO = '12345678'
const MUNICIPIO_IBGE = 3550308
const DOCUMENT_ID = '35261012345678000199660010000000011000000010'
const QR_URL = 'https://169.254.169.254/latest/meta-data/iam/security-credentials/?token=qr-secret'
const ARTIFACT_SHA256 = 'ab'.repeat(32)

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
  .values({
    codigoReceita: 3550308,
    codigoIbge: MUNICIPIO_IBGE,
    nomeNorm: 'SAO PAULO',
    uf: 'SP',
  })
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

const makeClaim = async (
  tenantId: string,
  overrides: { readonly numero?: string; readonly cep?: string } = {},
): Promise<ClaimFixture> => {
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
    logradouroNorm: 'RUA DAS FLORES',
    numero: overrides.numero ?? '123',
    bairroNorm: 'CENTRO',
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
      checkerVersion: fiscalCheckerVersion('1.0.0', input),
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

    await expect(run(nf3eAdapter, inputFor(claim, { source: 'nfag-e' }))).resolves.toBe('inserted')

    const row = (await fiscalRowsOf(claim.claimId))[0]
    expect(row).toMatchObject({ source: 'fiscal_nfag', checker: 'nfag-e_verification', stance: 'unknown' })
    expect(verificationOf(row)).toMatchObject({
      status: 'unsupported',
      document: 'unsupported',
      source: { kind: 'fiscal_nfag', id: 'nfag-e' },
    })
    expect(verify).not.toHaveBeenCalled()
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
