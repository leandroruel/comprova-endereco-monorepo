import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { toFiscalLookupInput, type FiscalReference } from '@comprova/core'
import {
  extractFiscalReferenceFromArtifact,
  extractFiscalReferenceFromPayloads,
  type FiscalReferenceArtifactInput,
} from './reference.js'

const NF3E_KEY = '35261012345678000199660010000000011000000015'
const SECOND_NF3E_KEY = '35261098765432000188660020000000022000000028'
const NF3E_URL = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${NF3E_KEY}&nVersao=4&tpAmb=1`

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  claimId: '00000000-0000-4000-8000-000000000002',
  artifact: null,
}

const fixture = (name: string): Uint8Array => {
  const buf = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

const extractFrom = (name: string, contentType: string): Promise<FiscalReference> =>
  extractFiscalReferenceFromArtifact({ data: fixture(name), contentType })

describe('extractFiscalReferenceFromArtifact (F2.2b física)', () => {
  it('decodifica QR válido em PNG', async () => {
    const reference = await extractFrom('qr-nf3e.png', 'image/png')

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'qr_code',
      url: NF3E_URL,
      limitations: [],
    })
    expect(reference.errorCodes).toEqual([])
    expect(reference.fingerprint).toHaveLength(32)
  })

  it('decodifica QR válido em JPEG', async () => {
    const reference = await extractFrom('qr-nf3e.jpg', 'image/jpeg')

    expect(reference).toMatchObject({
      status: 'found',
      source: 'nf3e',
      issuer: 'SVRS',
      uf: 'SP',
      documentId: NF3E_KEY,
      method: 'qr_code',
      url: NF3E_URL,
      errorCodes: [],
    })
  })

  it('decodifica QR em imagem raster embutida em PDF', async () => {
    const reference = await extractFrom('nf3e-qr.pdf', 'application/pdf')

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

  it('retorna not_found quando imagem não tem QR', async () => {
    const reference = await extractFrom('blank.png', 'image/png')

    expect(reference.status).toBe('not_found')
    expect(reference.fingerprint).toBeNull()
    expect(reference.errorCodes).toEqual([])
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('retorna inconclusive para imagem ilegível/corrompida', async () => {
    const reference = await extractFiscalReferenceFromArtifact({
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
      contentType: 'image/png',
    })

    expect(reference.status).toBe('inconclusive')
    expect(reference.errorCodes).toContain('IMAGE_DECODE_FAILED')
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('rejeita conteúdo que não é imagem válida', async () => {
    const reference = await extractFiscalReferenceFromArtifact({
      data: new TextEncoder().encode('apenas texto sem referência fiscal'),
      contentType: 'image/png',
    })

    expect(reference.status).toBe('inconclusive')
    expect(reference.errorCodes).toContain('IMAGE_DECODE_FAILED')
  })

  it('não transforma QR com URL de loopback em referência', async () => {
    // Fixture de QR real (não bytes de texto disfarçados de PNG). A matriz
    // completa de loopback/localhost/metadata/RFC1918 está em
    // reference-artifact.network.test.ts, que também envenena `fetch`.
    const reference = await extractFrom('qr-loopback-http.png', 'image/png')

    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toContain('UNSAFE_REFERENCE_URL')
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('dois QR codes distintos na mesma imagem viram ambíguo', async () => {
    const reference = await extractFrom('qr-two-different.png', 'image/png')

    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toContain('AMBIGUOUS_REFERENCE')
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('dois QR codes iguais na mesma imagem viram found', async () => {
    const reference = await extractFrom('qr-two-same.png', 'image/png')

    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe(NF3E_KEY)
    expect(reference.errorCodes).toEqual([])
  })

  it('dois QR distintos com maxSymbols = 2 ainda aplicam a política de ambiguidade', async () => {
    const reference = await extractFiscalReferenceFromArtifact(
      { data: fixture('qr-two-different.png'), contentType: 'image/png' },
      { maxSymbols: 2 },
    )

    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toContain('AMBIGUOUS_REFERENCE')
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('dois QR iguais com maxSymbols = 2 viram found', async () => {
    const reference = await extractFiscalReferenceFromArtifact(
      { data: fixture('qr-two-same.png'), contentType: 'image/png' },
      { maxSymbols: 2 },
    )

    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe(NF3E_KEY)
    expect(reference.errorCodes).toEqual([])
  })

  it('respeita maxSymbols mínimo sem rejeitar um único QR válido', async () => {
    const reference = await extractFiscalReferenceFromArtifact(
      { data: fixture('qr-nf3e.png'), contentType: 'image/png' },
      { maxSymbols: 1 },
    )

    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe(NF3E_KEY)
    expect(reference.errorCodes).toEqual([])
  })

  it('extrações concorrentes são determinísticas e compartilham o decoder', async () => {
    const [first, second] = await Promise.all([
      extractFrom('qr-nf3e.png', 'image/png'),
      extractFrom('qr-nf3e.png', 'image/png'),
    ])

    expect(first.status).toBe('found')
    expect(second.status).toBe('found')
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  it('um QR fiscal + imagem sem QR fica found (apenas o QR é decodificado)', async () => {
    const reference = await extractFrom('qr-plus-text.png', 'image/png')

    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe(NF3E_KEY)
    expect(reference.errorCodes).toEqual([])
  })

  it('não reconhece formato de artefato não suportado', async () => {
    const reference = await extractFiscalReferenceFromArtifact({
      data: new Uint8Array([1, 2, 3]),
      contentType: 'text/plain',
    })

    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toEqual(['UNSUPPORTED_ARTIFACT_TYPE'])
    expect(toFiscalLookupInput(reference, context)).toBeNull()
  })

  it('a referência decodificada contém URL mas a projeção persistível a remove', async () => {
    const reference = await extractFrom('qr-nf3e.png', 'image/png')
    expect(reference.url).toBe(NF3E_URL)

    const persisted = { ...reference, url: null }
    expect(persisted.url).toBeNull()
    expect(persisted.fingerprint).toBe(reference.fingerprint)
    expect(persisted.documentId).toBe(NF3E_KEY)

    const input = toFiscalLookupInput(persisted, context)
    expect(input).toEqual({
      source: 'nf3e',
      tenantId: context.tenantId,
      claimId: context.claimId,
      documentId: NF3E_KEY,
      qrCodeUrl: null,
      issuer: 'SVRS',
      uf: 'SP',
      artifact: null,
    })
  })

  it('não altera tenant, claim nem artifact ao gerar FiscalLookupInput', async () => {
    const reference = await extractFrom('qr-nf3e.png', 'image/png')

    const inputA = toFiscalLookupInput(reference, {
      ...context,
      tenantId: 'tenant-A',
      claimId: 'claim-A',
      artifact: { artifactId: 'artifact-A', sha256: 'ab'.repeat(32) },
    })
    const inputB = toFiscalLookupInput(reference, {
      ...context,
      tenantId: 'tenant-B',
      claimId: 'claim-B',
      artifact: null,
    })

    expect(inputA?.tenantId).toBe('tenant-A')
    expect(inputA?.claimId).toBe('claim-A')
    expect(inputA?.artifact?.artifactId).toBe('artifact-A')
    expect(inputB?.tenantId).toBe('tenant-B')
    expect(inputB?.claimId).toBe('claim-B')
    expect(inputB?.artifact).toBeNull()
  })
})

describe('extractFiscalReferenceFromPayloads (política de múltiplos QR)', () => {
  it('payloads duplicados do mesmo fingerprint viram found', () => {
    const reference = extractFiscalReferenceFromPayloads([NF3E_URL, NF3E_URL])
    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe(NF3E_KEY)
  })

  it('múltiplas referências fiscais distintas viram ambíguo', () => {
    const reference = extractFiscalReferenceFromPayloads([
      NF3E_URL,
      `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${SECOND_NF3E_KEY}&nVersao=4&tpAmb=1`,
    ])
    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toEqual(['AMBIGUOUS_REFERENCE'])
  })

  it('QR único + QR não fiscal fica found com limitação MULTIPLE_QR_CODES', () => {
    const reference = extractFiscalReferenceFromPayloads([NF3E_URL, 'https://marketing.example/promo'])
    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe(NF3E_KEY)
    expect(reference.limitations).toContain('MULTIPLE_QR_CODES')
  })

  it('nenhum payload viram not_found', () => {
    expect(extractFiscalReferenceFromPayloads([]).status).toBe('not_found')
    expect(extractFiscalReferenceFromPayloads(['', '   ']).status).toBe('not_found')
  })
})

describe('FiscalReferenceArtifactInput type', () => {
  it('aceita Uint8Array e contentType', () => {
    const input: FiscalReferenceArtifactInput = {
      data: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    }
    expect(input.data.byteLength).toBe(3)
    expect(input.contentType).toBe('image/png')
  })
})
