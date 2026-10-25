import { fiscalReferenceFingerprint, toFiscalLookupInput } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import { extractFiscalReference } from './reference.js'

const NF3E_KEY = '35261012345678000199660010000000011000000015'
const SECOND_NF3E_KEY = '35261098765432000188660020000000022000000028'
const NF3E_URL = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}&nVersao=4&tpAmb=1`

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  claimId: '00000000-0000-4000-8000-000000000002',
  artifact: null,
}

describe('extractFiscalReference (F2.2a)', () => {
  it('reconhece uma NF3e por URL + chave de acesso válida', () => {
    const reference = extractFiscalReference({ value: NF3E_URL, method: 'qr_code' })

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'qr_code',
      limitations: [],
    })
    expect(reference.url).toBe(NF3E_URL)
    expect(reference.fingerprint).toHaveLength(32)
    expect(reference.errorCodes).toEqual([])
  })

  it('reconhece o parâmetro oficial chNF3e do QR', () => {
    const officialUrl = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNF3e=${NF3E_KEY}&tpAmb=1`
    const reference = extractFiscalReference({ value: officialUrl, method: 'qr_code' })

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'qr_code',
    })
    expect(reference.errorCodes).toEqual([])
  })

  it('reconhece chave de acesso isolada como NF3e, sem inventar autorizador', () => {
    const reference = extractFiscalReference({ value: NF3E_KEY })

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: null,
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'access_key',
      limitations: ['UNKNOWN_ISSUER'],
    })
    expect(reference.url).toBeNull()
    expect(reference.errorCodes).toEqual([])
  })

  it.each([
    ['SVRS', 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode'],
    ['SC', 'https://sat.sef.sc.gov.br/nf3e/consulta'],
    ['MG', 'https://portalsped.fazenda.mg.gov.br/portalnf3e/sistema/qrcode.xhtml'],
    ['MT', 'https://www.sefaz.mt.gov.br/nf3e/QRCode'],
  ])('reconhece o endpoint NF3e do autorizador %s', (issuer, url) => {
    const reference = extractFiscalReference({ value: `${url}?chNFe=${NF3E_KEY}` })

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer,
      uf: 'SP',
      documentId: NF3E_KEY,
    })
    expect(reference.errorCodes).toEqual([])
  })

  it('não classifica texto com prefixo como URL', () => {
    const reference = extractFiscalReference({ value: `Chave: ${NF3E_KEY}` })

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      documentId: NF3E_KEY,
      method: 'text',
    })
  })

  it('normaliza query parameters de forma determinística', () => {
    const shuffled = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?tpAmb=1&nVersao=4&chNFe=${NF3E_KEY}`
    const first = extractFiscalReference({ value: NF3E_URL })
    const second = extractFiscalReference({ value: shuffled })

    expect(first.url).toBe(second.url)
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.url).not.toContain('#')
  })

  it('extrai uma referência de um texto, sem persistir o texto bruto', () => {
    const text = `Comprovante do CPF 529.982.247-25. QR: ${NF3E_URL}. Fim.`
    const reference = extractFiscalReference({ value: text, method: 'text' })

    expect(reference).toMatchObject({ status: 'found', source: 'nf3e', documentId: NF3E_KEY })
    expect(JSON.stringify(reference)).not.toContain('529.982.247-25')
    expect(JSON.stringify(reference)).not.toContain('52998224725')
    expect(JSON.stringify(reference)).not.toContain('Comprovante')
  })

  it('converte a referência encontrada em FiscalLookupInput com contexto confiável', () => {
    const reference = extractFiscalReference({ value: NF3E_URL, method: 'qr_code' })
    const input = toFiscalLookupInput(reference, context)

    expect(input).toEqual({
      source: 'nf3e',
      tenantId: context.tenantId,
      claimId: context.claimId,
      documentId: NF3E_KEY,
      qrCodeUrl: NF3E_URL,
      issuer: 'SVRS',
      uf: 'SP',
      artifact: null,
    })
  })

  it('não reconhece URL desconhecida como NF3e por palpite', () => {
    const reference = extractFiscalReference({ value: 'https://evil.example/qualquer/coisa' })
    expect(reference).toMatchObject({
      status: 'unsupported',
      source: null,
      errorCodes: ['REFERENCE_NOT_RECOGNIZED'],
    })
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('não reconhece domínio desconhecido apenas pelo caminho nf3e', () => {
    const reference = extractFiscalReference({
      value: 'https://evil.example/nf3e/qrCode',
    })
    expect(reference).toMatchObject({
      status: 'unsupported',
      source: null,
      issuer: null,
      errorCodes: ['REFERENCE_NOT_RECOGNIZED'],
    })
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('não reconhece caminho inesperado em host de autorizador conhecido', () => {
    const reference = extractFiscalReference({
      value: 'https://dfe-portal.svrs.rs.gov.br/qualquer/nf3e',
    })
    expect(reference).toMatchObject({
      status: 'unsupported',
      source: null,
      issuer: null,
      errorCodes: ['REFERENCE_NOT_RECOGNIZED'],
    })
  })

  it('reconhece chave válida em domínio desconhecido sem inventar autorizador', () => {
    const reference = extractFiscalReference({
      value: `https://evil.example/nf3e/qrCode?chNFe=${NF3E_KEY}`,
    })
    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: null,
      limitations: ['UNKNOWN_ISSUER'],
    })
    expect(reference.issuer).toBeNull()
    expect(reference.errorCodes).toEqual([])
  })

  it('marca URL de autorizador conhecida sem chave como referência incompleta', () => {
    const reference = extractFiscalReference({
      value: 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode',
    })
    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      documentId: null,
      limitations: ['DOCUMENT_ID_MISSING'],
    })
    expect(reference.errorCodes).toEqual([])
  })

  it('rejeita parâmetros de chave duplicados ou conflitantes', () => {
    const duplicated = extractFiscalReference({
      value: `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}&chNFe=${NF3E_KEY}`,
    })
    expect(duplicated).toMatchObject({
      status: 'unsupported',
      source: 'nf3e',
      errorCodes: ['AMBIGUOUS_REFERENCE'],
    })

    const conflicting = extractFiscalReference({
      value: `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}&chave=${SECOND_NF3E_KEY}`,
    })
    expect(conflicting).toMatchObject({
      status: 'unsupported',
      source: 'nf3e',
      errorCodes: ['AMBIGUOUS_REFERENCE'],
    })
    expect(toFiscalLookupInput(conflicting, context)).toBeNull()
  })

  it('rejeita chave com caracteres inesperados', () => {
    const malformed = extractFiscalReference({
      value: `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY.slice(0, 22)}.${NF3E_KEY.slice(22)}`,
    })
    expect(malformed).toMatchObject({
      status: 'unsupported',
      source: 'nf3e',
      errorCodes: ['INVALID_DOCUMENT_ID'],
    })
  })

  it('marca NFAg-e explicitamente como não suportada', () => {
    const reference = extractFiscalReference({
      value: 'https://dfe-portal.svrs.rs.gov.br/nfag/qrCode?chave=qualquer',
    })
    expect(reference).toMatchObject({
      status: 'unsupported',
      source: 'nfag-e',
      errorCodes: ['SOURCE_NOT_SUPPORTED'],
    })
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it.each([
    ['loopback IPv4', 'http://127.0.0.1/nf3e/qrCode'],
    ['localhost', 'https://localhost/nf3e/qrCode'],
    ['metadata', 'https://169.254.169.254/latest/meta-data'],
    ['RFC1918', 'https://10.0.0.1/nf3e/qrCode'],
    ['IPv6 loopback', 'https://[::1]/nf3e/qrCode'],
    ['IPv6 unique local', 'https://[fd00::1]/nf3e/qrCode'],
    ['credenciais embutidas', 'https://user:pass@dfe-portal.svrs.rs.gov.br/nf3e/qrCode'],
    ['http sem TLS', 'http://dfe-portal.svrs.rs.gov.br/nf3e/qrCode'],
  ])('nunca autoriza referência %s', (_name, value) => {
    const reference = extractFiscalReference({ value })
    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toEqual(['UNSAFE_REFERENCE_URL'])
    expect(reference.fingerprint).toBeNull()
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('retorna not_found quando não há referência fiscal', () => {
    expect(extractFiscalReference({ value: null })).toMatchObject({ status: 'not_found' })
    expect(extractFiscalReference({ value: '   ' })).toMatchObject({ status: 'not_found' })
    expect(extractFiscalReference({ value: 'apenas texto sem referência' })).toMatchObject({
      status: 'not_found',
    })
    expect(extractFiscalReference({ value: '12345678901234567890123456789012345678901234' })).toMatchObject({
      status: 'unsupported',
      errorCodes: ['NOT_NF3E_DOCUMENT'],
    })
  })

  it('rejeita identificador fiscal inválido sem produzir input', () => {
    const wrongModel = extractFiscalReference({
      value: '35261012345678000199550010000000011000000015',
    })
    expect(wrongModel).toMatchObject({
      status: 'unsupported',
      source: null,
      errorCodes: ['NOT_NF3E_DOCUMENT'],
    })

    const wrongModelInUrl = extractFiscalReference({
      value: `https://evil.example/qualquer?chave=35261012345678000199550010000000011000000015`,
    })
    expect(wrongModelInUrl).toMatchObject({
      status: 'unsupported',
      source: null,
      errorCodes: ['NOT_NF3E_DOCUMENT'],
    })

    const wrongDigit = extractFiscalReference({
      value: '35261012345678000199660010000000011000000010',
    })
    expect(wrongDigit).toMatchObject({ status: 'unsupported', errorCodes: ['INVALID_DOCUMENT_ID'] })

    const missingKey = extractFiscalReference({
      value: 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=invalida',
    })
    expect(missingKey).toMatchObject({ status: 'unsupported', errorCodes: ['INVALID_DOCUMENT_ID'] })

    const extraDigit = extractFiscalReference({
      value: `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}9`,
    })
    expect(extraDigit).toMatchObject({ status: 'unsupported', errorCodes: ['INVALID_DOCUMENT_ID'] })
    expect(toFiscalLookupInput(missingKey, context)).toBeNull()
  })

  it('não escolhe uma referência quando o texto é ambíguo', () => {
    const twoUrls = `QR1 ${NF3E_URL} QR2 https://sat.sef.sc.gov.br/nf3e/consulta?chNFe=${SECOND_NF3E_KEY}`
    expect(extractFiscalReference({ value: twoUrls })).toMatchObject({
      status: 'unsupported',
      errorCodes: ['AMBIGUOUS_REFERENCE'],
    })

    const twoKeys = `${NF3E_KEY} e ${SECOND_NF3E_KEY}`
    expect(extractFiscalReference({ value: twoKeys })).toMatchObject({
      status: 'unsupported',
      errorCodes: ['AMBIGUOUS_REFERENCE'],
    })
  })

  it('produz o mesmo fingerprint para a mesma referência normalizada', () => {
    const first = extractFiscalReference({ value: NF3E_URL })
    const second = extractFiscalReference({ value: NF3E_URL })
    expect(fiscalReferenceFingerprint(first)).toBe(fiscalReferenceFingerprint(second))
    expect(fiscalReferenceFingerprint(first)).toBe(first.fingerprint)
  })

  it('encontra URL dentro de texto com outros números', () => {
    const reference = extractFiscalReference({
      value: `Protocolo 12345678901234 - consulte em ${NF3E_URL}`,
    })
    expect(reference).toMatchObject({ status: 'found', documentId: NF3E_KEY })
  })
})
