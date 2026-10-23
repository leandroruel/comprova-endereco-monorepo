import { describe, expect, it } from 'vitest'
import type { DocumentAnalysisResult, ExtractedAddress, ExtractedHolder } from './document-analysis.js'
import {
  compareAddress,
  compareHolder,
  uploadedDocumentCheckerVersion,
  stanceForVerification,
  verifyUploadedDocument,
  type AddressComparisonTarget,
} from './evidence-verification.js'

const ADDRESS: ExtractedAddress = {
  logradouro: 'RUA DAS FLORES',
  numero: '123',
  complemento: 'APTO 45',
  bairro: 'CENTRO',
  cidade: 'SAO PAULO',
  uf: 'SP',
  cep: '01001000',
  raw: 'Rua das Flores, 123, Apto 45',
}

const HOLDER: ExtractedHolder = {
  name: 'Empresa Exemplo Ltda',
  raw: 'Titular: Empresa Exemplo Ltda',
}

const TARGET: AddressComparisonTarget = {
  cep: '01001000',
  uf: 'SP',
  logradouroNorm: 'RUA DAS FLORES',
  numero: '123',
  bairroNorm: 'CENTRO',
  municipioNorm: 'SAO PAULO',
  complementoNorm: null,
}

const completedResult = (overrides: Partial<DocumentAnalysisResult> = {}): DocumentAnalysisResult => ({
  contractVersion: '2',
  analyzer: { id: 'text_document', version: '1.1.0' },
  status: 'completed',
  document: {
    status: 'analyzed',
    kind: 'unknown',
    issuedAt: '2026-10-01',
    issuedRaw: 'Emissão: 01/10/2026',
  },
  address: { status: 'extracted', value: ADDRESS, raw: ADDRESS.raw },
  holder: { status: 'extracted', value: HOLDER, raw: HOLDER.raw },
  limitations: [],
  errorCodes: [],
  analyzedAt: '2026-10-22T12:00:00.000Z',
  ...overrides,
})

const verify = (result: DocumentAnalysisResult) =>
  verifyUploadedDocument({
    analysisId: '00000000-0000-4000-8000-000000000001',
    artifactId: '00000000-0000-4000-8000-000000000002',
    artifactSha256: 'ab'.repeat(32),
    contentType: 'application/pdf',
    result,
    addressTarget: TARGET,
    holderReference: { legalName: 'Empresa Exemplo Ltda', tradeName: 'Empresa Exemplo' },
  })

describe('compareAddress', () => {
  it('retorna matches quando os campos fortes coincidem', () => {
    const comparison = compareAddress(ADDRESS, TARGET)
    expect(comparison.outcome).toBe('matches')
    expect(comparison.comparedFields).toEqual(
      expect.arrayContaining(['cep', 'uf', 'logradouro', 'numero', 'bairro', 'cidade']),
    )
  })

  it('retorna differs em conflito de campo forte', () => {
    const comparison = compareAddress({ ...ADDRESS, numero: '999' }, TARGET)
    expect(comparison.outcome).toBe('differs')
    expect(comparison.reasonCodes).toContain('NUMERO_MISMATCH')
  })

  it('nao usa substring como equivalencia', () => {
    const comparison = compareAddress({ ...ADDRESS, logradouro: 'RUA DAS FLORES II' }, TARGET)
    expect(comparison.outcome).toBe('differs')
  })

  it('retorna not_extracted sem campo forte comparavel', () => {
    const comparison = compareAddress(
      { ...ADDRESS, cep: null, logradouro: null, numero: null, bairro: 'CENTRO', cidade: 'SAO PAULO' },
      TARGET,
    )
    expect(comparison.outcome).toBe('not_extracted')
  })

  it('retorna not_extracted quando o alvo nao existe', () => {
    expect(compareAddress(ADDRESS, null)).toMatchObject({
      outcome: 'not_extracted',
      reasonCodes: ['TARGET_ADDRESS_MISSING'],
    })
  })

  it('bairro divergente nao contradiz sozinho', () => {
    const comparison = compareAddress({ ...ADDRESS, bairro: 'JARDIM' }, TARGET)
    expect(comparison.outcome).toBe('matches')
    expect(comparison.reasonCodes).toContain('SOFT_FIELD_MISMATCH')
  })
})

describe('compareHolder', () => {
  it('compara a razao social ignorando sufixo societario', () => {
    expect(
      compareHolder(
        { name: 'EMPRESA EXEMPLO', raw: '' },
        { legalName: 'Empresa Exemplo Ltda', tradeName: null },
      ),
    ).toMatchObject({ outcome: 'matches', reference: 'legal_name' })
  })

  it('compara o nome fantasia', () => {
    expect(
      compareHolder(
        { name: 'Empresa Exemplo', raw: '' },
        { legalName: 'Razao Social Diferente Ltda', tradeName: 'Empresa Exemplo' },
      ),
    ).toMatchObject({ outcome: 'matches', reference: 'trade_name' })
  })

  it('retorna differs quando ha razao social e o nome nao coincide', () => {
    expect(
      compareHolder(
        { name: 'Outra Empresa', raw: '' },
        { legalName: 'Empresa Exemplo Ltda', tradeName: null },
      ),
    ).toMatchObject({ outcome: 'differs', reasonCodes: ['NAME_MISMATCH'] })
  })

  it('nao contradiz quando so ha nome fantasia e o nome difere', () => {
    expect(
      compareHolder(
        { name: 'Razao Social Diferente', raw: '' },
        { legalName: null, tradeName: 'Empresa Exemplo' },
      ),
    ).toMatchObject({
      outcome: 'not_extracted',
      reference: 'trade_name',
      reasonCodes: ['HOLDER_REFERENCE_WEAK'],
    })
  })

  it('retorna not_extracted sem titular extraido', () => {
    expect(
      compareHolder({ name: null, raw: '' }, { legalName: 'Empresa Exemplo Ltda', tradeName: null }),
    ).toMatchObject({ outcome: 'not_extracted', reasonCodes: ['HOLDER_NOT_EXTRACTED'] })
  })

  it('retorna not_extracted sem referencia', () => {
    expect(compareHolder(HOLDER, null)).toMatchObject({
      outcome: 'not_extracted',
      reasonCodes: ['HOLDER_REFERENCE_MISSING'],
    })
  })

  it('nao usa substring para titular', () => {
    expect(
      compareHolder(
        { name: 'Empresa Exemplo', raw: '' },
        { legalName: 'Empresa Exemplo Ltda', tradeName: null },
      ).outcome,
    ).toBe('matches')
    expect(
      compareHolder({ name: 'Exemplo', raw: '' }, { legalName: 'Empresa Exemplo Ltda', tradeName: null })
        .outcome,
    ).toBe('differs')
  })
})

describe('verifyUploadedDocument', () => {
  it('materializa as tres dimensoes sem autenticar o upload', () => {
    const verification = verify(completedResult())

    expect(verification).toMatchObject({
      status: 'completed',
      source: { kind: 'uploaded_document', id: 'upload:pdf', authority: null, environment: 'production' },
      method: 'content_extraction',
      document: 'inconclusive',
      address: 'matches',
      holder: 'matches',
      documentRef: 'analysis:00000000-0000-4000-8000-000000000001',
      artifact: { sha256: 'ab'.repeat(32), storageRef: null },
    })
    expect(verification.limitations).toContain('AUTHENTICITY_NOT_VERIFIED')
    expect(verification.extractedAt.toISOString()).toBe('2026-10-22T12:00:00.000Z')
    expect(stanceForVerification(verification)).toBe('unknown')
  })

  it('documento invalido nao produz endereco/titular validos nem contradicao', () => {
    const verification = verify(
      completedResult({
        status: 'inconclusive',
        document: { status: 'invalid', kind: 'unknown', issuedAt: null, issuedRaw: null },
        address: { status: 'unknown', value: null, raw: null },
        holder: { status: 'unknown', value: null, raw: null },
        errorCodes: ['PDF_INVALID'],
      }),
    )

    expect(verification).toMatchObject({
      status: 'invalid',
      document: 'invalid',
      address: 'not_extracted',
      holder: 'not_extracted',
    })
    expect(verification.limitations).toContain('DOCUMENT_INVALID')
    expect(stanceForVerification(verification)).toBe('unknown')
  })

  it('PDF sem camada textual nao vira differs', () => {
    const verification = verify(
      completedResult({
        status: 'inconclusive',
        document: { status: 'inconclusive', kind: 'unknown', issuedAt: null, issuedRaw: null },
        address: { status: 'unknown', value: null, raw: null },
        holder: { status: 'unknown', value: null, raw: null },
        errorCodes: ['NO_TEXT_LAYER'],
      }),
    )

    expect(verification.status).toBe('inconclusive')
    expect(verification.document).toBe('inconclusive')
    expect(verification.address).toBe('not_extracted')
    expect(verification.holder).toBe('not_extracted')
    expect(stanceForVerification(verification)).toBe('unknown')
  })

  it.each(['unsupported', 'unavailable', 'failed'] as const)('status %s nunca vira contradicts', (status) => {
    const verification = verify(
      completedResult({
        status,
        document: {
          status: status === 'unsupported' ? 'unsupported' : 'unavailable',
          kind: 'unknown',
          issuedAt: null,
          issuedRaw: null,
        },
        address: { status: 'unknown', value: null, raw: null },
        holder: { status: 'unknown', value: null, raw: null },
        errorCodes: ['TEST'],
      }),
    )

    expect(verification.address).toBe('not_extracted')
    expect(verification.holder).toBe('not_extracted')
    expect(stanceForVerification(verification)).toBe('unknown')
  })

  it('e deterministico e nao expoe PII', () => {
    const first = verify(completedResult())
    const second = verify(completedResult())
    expect(second).toEqual(first)
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain('Empresa Exemplo')
    expect(serialized).not.toContain('Rua das Flores')
    expect(serialized).not.toContain('01001-000')
    expect(serialized).not.toContain('529.982.247-25')
  })

  it('inclui analisador/contrato na chave de versao', () => {
    expect(uploadedDocumentCheckerVersion('1.1.0', '2')).toBe('1.0.0+1.1.0+c2')
    expect(uploadedDocumentCheckerVersion('1.2.0', '2')).not.toBe(
      uploadedDocumentCheckerVersion('1.1.0', '2'),
    )
  })
})
