import { describe, expect, it } from 'vitest'
import { stanceForDimensions } from './evidence-verification.js'
import {
  FISCAL_REASON_CODES,
  FISCAL_SOURCE_KIND,
  FISCAL_VERIFICATION_CONTRACT_VERSION,
  fiscalCheckerId,
  fiscalCheckerVersion,
  fiscalDocumentFingerprint,
  fiscalEvidenceSourceRef,
  fiscalVerificationStatusOf,
  isFiscalReasonCode,
  isFiscalTerminalDocumentOutcome,
  unavailableFiscalVerification,
  unsupportedFiscalVerification,
  type FiscalLookupInput,
} from './fiscal-verification.js'

const INPUT: FiscalLookupInput = {
  source: 'nf3e',
  tenantId: '00000000-0000-4000-8000-000000000001',
  claimId: '00000000-0000-4000-8000-000000000002',
  documentId: '35261012345678000199660010000000011000000010',
  qrCodeUrl: 'https://example.test/nf3e/qr?token=secret',
  issuer: 'SVRS',
  uf: 'SP',
  artifact: null,
}

describe('contrato fiscal', () => {
  it('mapeia os identificadores de fonte para a taxonomia existente', () => {
    expect(FISCAL_SOURCE_KIND).toEqual({ nf3e: 'fiscal_nf3e', 'nfag-e': 'fiscal_nfag' })
    expect(fiscalCheckerId('nf3e')).toBe('nf3e_verification')
    expect(fiscalEvidenceSourceRef('nfag-e', 'SVRS', 'homologation')).toEqual({
      kind: 'fiscal_nfag',
      id: 'nfag-e',
      authority: 'SVRS',
      environment: 'homologation',
    })
  })

  it('usa a taxonomia de status existente, preservando not_found no documento', () => {
    expect(fiscalVerificationStatusOf('authentic')).toBe('completed')
    expect(fiscalVerificationStatusOf('not_found')).toBe('completed')
    expect(fiscalVerificationStatusOf('invalid')).toBe('invalid')
    expect(fiscalVerificationStatusOf('inconclusive')).toBe('inconclusive')
    expect(fiscalVerificationStatusOf('unavailable')).toBe('unavailable')
    expect(fiscalVerificationStatusOf('unsupported')).toBe('unsupported')
  })

  it('deriva uma chave estável sem expor a chave/URL do documento', () => {
    const fingerprint = fiscalDocumentFingerprint(INPUT)
    expect(fingerprint).toMatch(/^[a-f0-9]{32}$/)
    expect(fingerprint).not.toContain('352610')
    expect(fiscalDocumentFingerprint({ ...INPUT })).toBe(fingerprint)
    expect(fiscalDocumentFingerprint({ ...INPUT, documentId: 'outro-documento' })).not.toBe(fingerprint)
    expect(fiscalDocumentFingerprint({ ...INPUT, documentId: null })).not.toBe(fingerprint)
  })

  it('inclui versão do adapter, documento e contrato na versão do checker', () => {
    expect(fiscalCheckerVersion('1.0.0', INPUT)).toBe(
      `1.0.0+d${fiscalDocumentFingerprint(INPUT)}+c${FISCAL_VERIFICATION_CONTRACT_VERSION}`,
    )
    expect(fiscalCheckerVersion('1.1.0', INPUT)).not.toBe(fiscalCheckerVersion('1.0.0', INPUT))
    expect(fiscalCheckerVersion('1.0.0', { ...INPUT, documentId: 'outro' })).not.toBe(
      fiscalCheckerVersion('1.0.0', INPUT),
    )
  })

  it('distingue o adapter de origem e resultados transitórios na chave', () => {
    expect(
      fiscalCheckerVersion('1.0.0', INPUT, {
        adapterSource: 'nf3e',
        documentOutcome: 'authentic',
      }),
    ).toBe(`1.0.0+anf3e+d${fiscalDocumentFingerprint(INPUT)}+c${FISCAL_VERIFICATION_CONTRACT_VERSION}`)

    const unavailable = fiscalCheckerVersion('1.0.0', INPUT, {
      adapterSource: 'nf3e',
      documentOutcome: 'unavailable',
    })
    expect(unavailable).toContain('+ounavailable')
    expect(unavailable).not.toBe(
      fiscalCheckerVersion('1.0.0', INPUT, { adapterSource: 'nf3e', documentOutcome: 'authentic' }),
    )
    expect(
      fiscalCheckerVersion('1.0.0', INPUT, {
        adapterSource: 'nf3e',
        documentOutcome: 'unsupported',
      }),
    ).not.toBe(
      fiscalCheckerVersion('1.0.0', INPUT, {
        adapterSource: 'nfag-e',
        documentOutcome: 'unsupported',
      }),
    )
  })

  it('tem allowlist finita de reason codes e classifica terminais', () => {
    expect(FISCAL_REASON_CODES).toContain('SEFAZ_TIMEOUT')
    expect(isFiscalReasonCode('SEFAZ_TIMEOUT')).toBe(true)
    expect(isFiscalReasonCode('CPF_12345678900')).toBe(false)
    expect(isFiscalReasonCode('SECRET_TOKEN')).toBe(false)

    for (const outcome of ['authentic', 'not_found', 'invalid'] as const) {
      expect(isFiscalTerminalDocumentOutcome(outcome)).toBe(true)
    }
    for (const outcome of ['unavailable', 'inconclusive', 'unsupported'] as const) {
      expect(isFiscalTerminalDocumentOutcome(outcome)).toBe(false)
    }
  })

  it('nunca transforma indisponibilidade/inconclusivo/unsupported em contradicts', () => {
    for (const document of ['unavailable', 'inconclusive', 'unsupported', 'invalid', 'not_found'] as const) {
      expect(stanceForDimensions({ document, address: 'matches', holder: 'matches' })).toBe('unknown')
    }
  })

  it('mapeia as três dimensões independentes quando a fonte autentica o documento', () => {
    expect(stanceForDimensions({ document: 'authentic', address: 'matches', holder: 'not_extracted' })).toBe(
      'supports',
    )
    expect(stanceForDimensions({ document: 'authentic', address: 'differs', holder: 'matches' })).toBe(
      'contradicts',
    )
    expect(stanceForDimensions({ document: 'authentic', address: 'matches', holder: 'differs' })).toBe(
      'unknown',
    )
    expect(stanceForDimensions({ document: 'authentic', address: 'not_extracted', holder: 'matches' })).toBe(
      'unknown',
    )
  })

  it.each([
    ['matches', 'matches', 'supports'],
    ['matches', 'differs', 'unknown'],
    ['matches', 'not_extracted', 'supports'],
    ['differs', 'matches', 'contradicts'],
    ['differs', 'differs', 'unknown'],
    ['differs', 'not_extracted', 'unknown'],
    ['not_extracted', 'matches', 'unknown'],
    ['not_extracted', 'differs', 'unknown'],
    ['not_extracted', 'not_extracted', 'unknown'],
  ] as const)('mapeia address=%s e holder=%s para stance=%s', (address, holder, expected) => {
    expect(stanceForDimensions({ document: 'authentic', address, holder })).toBe(expected)
  })

  it('constrói estados neutros para fonte não suportada e indisponível', () => {
    const now = new Date('2026-10-23T12:00:00.000Z')
    const unsupported = unsupportedFiscalVerification(INPUT, '1.0.0', now, 'SOURCE_NOT_SUPPORTED')
    expect(unsupported).toMatchObject({
      source: 'nf3e',
      adapterVersion: '1.0.0',
      document: 'unsupported',
      address: 'not_extracted',
      holder: 'not_extracted',
      observedAt: now,
    })
    expect(unsupported).not.toHaveProperty('trust_score')
    expect(unsupported).not.toHaveProperty('approved')

    const unavailable = unavailableFiscalVerification(INPUT, '1.0.0', now, 'SEFAZ_TIMEOUT')
    expect(unavailable.document).toBe('unavailable')
    expect(unavailable.document).not.toBe('invalid')
    expect(unavailable.limitations).toEqual(['SEFAZ_TIMEOUT'])
  })
})
