import { describe, expect, it } from 'vitest'
import {
  FISCAL_REFERENCE_CONTRACT_VERSION,
  FISCAL_REFERENCE_STATUSES,
  fiscalReferenceFingerprint,
  redactFiscalReference,
  toFiscalLookupInput,
  type FiscalReference,
} from './fiscal-reference.js'

const NF3E_KEY = '35261012345678000199660010000000011000000015'

const foundReference = (overrides: Partial<FiscalReference> = {}): FiscalReference => ({
  contractVersion: FISCAL_REFERENCE_CONTRACT_VERSION,
  status: 'found',
  source: 'nf3e',
  issuer: 'SVRS',
  uf: 'SP',
  url: 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=' + NF3E_KEY,
  documentId: NF3E_KEY,
  method: 'qr_code',
  limitations: [],
  errorCodes: [],
  fingerprint: 'a'.repeat(32),
  ...overrides,
})

describe('contrato de referência fiscal (F2.2a)', () => {
  it('converte uma referência encontrada usando o contexto confiável', () => {
    const input = toFiscalLookupInput(foundReference(), {
      tenantId: '00000000-0000-4000-8000-000000000001',
      claimId: '00000000-0000-4000-8000-000000000002',
      artifact: { artifactId: '00000000-0000-4000-8000-000000000003', sha256: 'ab'.repeat(32) },
    })

    expect(input).toEqual({
      source: 'nf3e',
      tenantId: '00000000-0000-4000-8000-000000000001',
      claimId: '00000000-0000-4000-8000-000000000002',
      documentId: NF3E_KEY,
      qrCodeUrl: 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=' + NF3E_KEY,
      issuer: 'SVRS',
      uf: 'SP',
      artifact: { artifactId: '00000000-0000-4000-8000-000000000003', sha256: 'ab'.repeat(32) },
    })
  })

  it('não produz input quando a referência não foi encontrada ou não tem fonte', () => {
    const context = {
      tenantId: '00000000-0000-4000-8000-000000000001',
      claimId: '00000000-0000-4000-8000-000000000002',
      artifact: null,
    }
    expect(toFiscalLookupInput(foundReference({ status: 'not_found' }), context)).toBeNull()
    expect(toFiscalLookupInput(foundReference({ status: 'inconclusive' }), context)).toBeNull()
    expect(toFiscalLookupInput(foundReference({ status: 'unsupported' }), context)).toBeNull()
    expect(toFiscalLookupInput(foundReference({ source: null }), context)).toBeNull()
    expect(FISCAL_REFERENCE_STATUSES).toContain('inconclusive')
  })

  it('exige contexto confiável não vazio', () => {
    expect(
      toFiscalLookupInput(foundReference(), { tenantId: '  ', claimId: 'claim', artifact: null }),
    ).toBeNull()
    expect(
      toFiscalLookupInput(foundReference(), { tenantId: 'tenant', claimId: '', artifact: null }),
    ).toBeNull()
  })

  it('não deixa a referência alterar tenant/claim/artefato', () => {
    const tampered = {
      ...foundReference(),
      tenantId: '00000000-0000-4000-8000-0000000000ff',
      claimId: '00000000-0000-4000-8000-0000000000fe',
      artifact: { artifactId: 'x' },
    } as unknown as FiscalReference
    const input = toFiscalLookupInput(tampered, {
      tenantId: '00000000-0000-4000-8000-000000000001',
      claimId: '00000000-0000-4000-8000-000000000002',
      artifact: null,
    })
    expect(input?.tenantId).toBe('00000000-0000-4000-8000-000000000001')
    expect(input?.claimId).toBe('00000000-0000-4000-8000-000000000002')
    expect(input?.artifact).toBeNull()
  })

  it('calcula fingerprint determinístico da referência normalizada', () => {
    const first = foundReference({ fingerprint: fiscalReferenceFingerprint(foundReference()) })
    expect(first.fingerprint).toHaveLength(32)
    expect(fiscalReferenceFingerprint(foundReference())).toBe(first.fingerprint)
    expect(fiscalReferenceFingerprint(foundReference({ documentId: NF3E_KEY.replace(/5$/, '6') }))).not.toBe(
      first.fingerprint,
    )
    expect(fiscalReferenceFingerprint(foundReference({ status: 'unsupported' }))).toBeNull()
    expect(fiscalReferenceFingerprint(foundReference({ status: 'inconclusive' }))).toBeNull()
  })

  it('remove a URL do QR sem perder fingerprint nem documentId', () => {
    const original = foundReference({ fingerprint: fiscalReferenceFingerprint(foundReference()) })
    const redacted = redactFiscalReference(original)

    expect(redacted.url).toBeNull()
    expect(redacted.documentId).toBe(NF3E_KEY)
    expect(redacted.fingerprint).toBe(original.fingerprint)
    // Não recalcula o fingerprint: a identidade original é preservada.
    expect(redacted.fingerprint).toBe(fiscalReferenceFingerprint(original))
    expect(JSON.stringify(redacted)).not.toContain('dfe-portal.svrs.rs.gov.br')
  })

  it('é idempotente quando a URL já é nula', () => {
    const already = foundReference({
      url: null,
      fingerprint: fiscalReferenceFingerprint(foundReference({ url: null })),
    })
    expect(redactFiscalReference(already)).toBe(already)
  })
})
