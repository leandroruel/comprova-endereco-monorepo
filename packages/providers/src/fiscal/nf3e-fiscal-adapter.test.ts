import {
  FiscalAdapterUnavailableError,
  emptyFiscalAudit,
  type FiscalAdapterContext,
  type FiscalLookupInput,
} from '@comprova/core'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  SafeFetchError,
  type SafeFetch,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from '../safe-fetch.js'
import { makeFiscalEndpointAllowlist } from './endpoint.js'
import {
  NF3E_CONSULTATION_MAX_RESPONSE_BYTES,
  NF3E_CONSULTATION_TIMEOUT_MS,
  NF3E_FISCAL_ADAPTER_VERSION,
  makeNf3eFiscalAdapter,
  parseNf3eQrConsultationResponse,
} from './nf3e-fiscal-adapter.js'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const RS_KEY = '43191212345678000199660000000000101018342413'
const SVRS_QR = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNF3e=${RS_KEY}&tpAmb=1`
// Chave estruturalmente válida de uma NF3e SP (CNPJ conhecido da distribuidora,
// modelo 66 e DV calculado). O documento pode não existir no portal; o teste
// valida que a consulta chega ao autorizador, em vez de ser descartada por UF.
// A suíte não faz consulta live ao SVRS: o safeFetch permanece simulado para
// manter os testes determinísticos e sem dependência de rede externa.
const SP_KEY = '35261002302100000106660010000000011123456780'
const SP_QR = `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode?chNFe=${SP_KEY}&nVersao=4&tpAmb=1`
const HOSTILE_QR = 'https://169.254.169.254/latest/meta-data/iam/security-credentials/?token=secret'

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const FOUND_MINIMAL = fixture('nf3e-svrs-found-minimal.html')
const FOUND_FULL = fixture('nf3e-svrs-found-full.html')
const NOT_FOUND = fixture('nf3e-svrs-not-found.html')
const INVALID_KEY = fixture('nf3e-svrs-invalid-key.html')
const UNRECOGNIZED = fixture('nf3e-svrs-unrecognized.html')

const INPUT: FiscalLookupInput = {
  source: 'nf3e',
  tenantId: '00000000-0000-4000-8000-000000000001',
  claimId: '00000000-0000-4000-8000-000000000002',
  documentId: RS_KEY,
  qrCodeUrl: SVRS_QR,
  issuer: 'SVRS',
  uf: 'RS',
  artifact: {
    artifactId: '00000000-0000-4000-8000-000000000003',
    sha256: 'ab'.repeat(32),
  },
}

const SP_INPUT: FiscalLookupInput = {
  ...INPUT,
  documentId: SP_KEY,
  qrCodeUrl: SP_QR,
  uf: 'SP',
}

const CONTEXT: FiscalAdapterContext = {
  tenantId: INPUT.tenantId,
  claim: {
    address: {
      cep: '90010150',
      uf: 'RS',
      logradouroNorm: 'RUA DAS FLORES',
      numero: '123',
      bairroNorm: 'CENTRO',
      municipioNorm: 'PORTO ALEGRE',
      complementoNorm: null,
    },
    holder: { legalName: 'Empresa Exemplo Ltda', tradeName: null },
  },
  now: () => NOW,
}

const ALLOWLIST = makeFiscalEndpointAllowlist([
  {
    source: 'nf3e',
    issuer: 'SVRS',
    environment: 'local',
    url: 'https://fiscal.test/nf3e/qrCode',
  },
])

const responseOf = (body: string, status = 200): SafeFetchResponse => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(body),
  address: '203.0.113.10',
})

const safeFetchOf = (body: string, status = 200) =>
  vi.fn(async (_url: string, _options?: SafeFetchOptions) => responseOf(body, status))

const makeAdapter = (
  options: {
    readonly safeFetch?: SafeFetch
    readonly allowlist?: typeof ALLOWLIST
    readonly version?: string
  } = {},
) =>
  makeNf3eFiscalAdapter({
    environment: 'local',
    allowlist: options.allowlist ?? ALLOWLIST,
    safeFetch: options.safeFetch ?? safeFetchOf(FOUND_MINIMAL),
    version: options.version,
  })

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('Nf3eFiscalAdapter — escopo', () => {
  it('suporta NF3e/SVRS para RS e SP com chave e QR do autorizador', () => {
    const adapter = makeAdapter()

    expect(adapter.supports(INPUT)).toBe(true)
    expect(adapter.supports(SP_INPUT)).toBe(true)
    expect(adapter.supports({ ...INPUT, issuer: 'svrs' })).toBe(true)
    expect(adapter.supports({ ...INPUT, qrCodeUrl: null })).toBe(true)
    expect(adapter.supports({ ...SP_INPUT, documentId: RS_KEY })).toBe(false)
    expect(adapter.supports({ ...INPUT, source: 'nfag-e' })).toBe(false)
    expect(adapter.supports({ ...INPUT, issuer: null })).toBe(false)
    expect(adapter.supports({ ...INPUT, issuer: 'SC' })).toBe(false)
    expect(adapter.supports({ ...INPUT, uf: 'SC' })).toBe(false)
    expect(adapter.supports({ ...INPUT, uf: null })).toBe(false)
    expect(adapter.supports({ ...INPUT, documentId: null })).toBe(false)
    expect(adapter.supports({ ...SP_INPUT, documentId: `${SP_KEY.slice(0, 20)}65${SP_KEY.slice(22)}` })).toBe(
      false,
    )
    expect(adapter.supports({ ...INPUT, qrCodeUrl: HOSTILE_QR })).toBe(false)
  })

  it('recusa input não suportado sem chamar fetch', async () => {
    const safeFetch = vi.fn()
    const adapter = makeAdapter({ safeFetch })
    await expect(adapter.verify({ ...INPUT, issuer: 'SC' }, CONTEXT)).rejects.toBeInstanceOf(
      FiscalAdapterUnavailableError,
    )
    await expect(adapter.verify({ ...INPUT, qrCodeUrl: HOSTILE_QR }, CONTEXT)).rejects.toBeInstanceOf(
      FiscalAdapterUnavailableError,
    )
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('consulta uma chave NF3e de SP no endpoint SVRS', async () => {
    const safeFetch = safeFetchOf(NOT_FOUND)
    const adapter = makeAdapter({ safeFetch })

    const result = await adapter.verify(SP_INPUT, CONTEXT)

    expect(safeFetch).toHaveBeenCalledTimes(1)
    const [, options] = safeFetch.mock.calls[0] ?? []
    const body = new URLSearchParams(options?.body as string)
    expect(body.get('pesq.chBpe')).toBe(SP_KEY)
    expect(result).toMatchObject({ document: 'not_found', documentId: SP_KEY, issuer: 'SVRS' })
  })
})

describe('Nf3eFiscalAdapter — allowlist e fetch', () => {
  it('usa a URL da allowlist e envia POST de formulário, nunca a URL do QR', async () => {
    const safeFetch = safeFetchOf(FOUND_MINIMAL)
    const adapter = makeAdapter({ safeFetch })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(safeFetch).toHaveBeenCalledTimes(1)
    const [url, options] = safeFetch.mock.calls[0] ?? []
    expect(url).toBe('https://fiscal.test/nf3e/qrCode')
    expect(options).toMatchObject({
      method: 'POST',
      allowedContentTypes: ['text/html'],
      timeoutMs: NF3E_CONSULTATION_TIMEOUT_MS,
      maxResponseBytes: NF3E_CONSULTATION_MAX_RESPONSE_BYTES,
      headers: {
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    const body = new URLSearchParams(options?.body as string)
    expect(body.get('pesq.Sistema')).toBe('Nf3e')
    expect(body.get('pesq.tpAmb')).toBe('2')
    expect(body.get('pesq.chBpe')).toBe(RS_KEY)
    expect(body.get('pesq.chCte')).toBe(RS_KEY)
    expect(body.get('pesq.chMdfe')).toBe(RS_KEY)
    expect(JSON.stringify(safeFetch.mock.calls)).not.toContain('169.254.169.254')
    expect(JSON.stringify(safeFetch.mock.calls)).not.toContain('secret')

    expect(result).toMatchObject({
      source: 'nf3e',
      adapterVersion: NF3E_FISCAL_ADAPTER_VERSION,
      method: 'official_qr_consultation',
      environment: 'local',
      document: 'authentic',
      address: 'not_extracted',
      holder: 'not_extracted',
      issuer: 'SVRS',
      documentId: RS_KEY,
      issuedAt: null,
      observedAt: NOW,
      limitations: [],
      errorCodes: [],
      audit: {
        requestedUrl: 'https://fiscal.test/nf3e/qrCode',
        resolvedIp: '203.0.113.10',
        responseStatus: 200,
        responseSha256: sha256(FOUND_MINIMAL),
      },
    })
  })

  it('não chama o fetch quando o endpoint não está na allowlist', async () => {
    const safeFetch = vi.fn()
    const adapter = makeAdapter({ safeFetch, allowlist: makeFiscalEndpointAllowlist([]) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(safeFetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      document: 'unavailable',
      address: 'not_extracted',
      holder: 'not_extracted',
      limitations: ['SOURCE_UNAVAILABLE'],
      errorCodes: ['SOURCE_UNAVAILABLE'],
      audit: emptyFiscalAudit(),
    })
  })

  it.each([
    ['TIMEOUT', 'SEFAZ_TIMEOUT'],
    ['REQUEST_FAILED', 'SOURCE_UNAVAILABLE'],
    ['CONTENT_TYPE_NOT_ALLOWED', 'SOURCE_UNAVAILABLE'],
    ['RESPONSE_TOO_LARGE', 'SOURCE_UNAVAILABLE'],
  ] as const)('mapeia falha de fetch %s para unavailable', async (safeReason, reason) => {
    const safeFetch: SafeFetch = vi.fn(async () => {
      throw new SafeFetchError(safeReason)
    })
    const adapter = makeAdapter({ safeFetch })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'unavailable',
      address: 'not_extracted',
      holder: 'not_extracted',
      limitations: [reason],
      errorCodes: [reason],
      audit: {
        requestedUrl: 'https://fiscal.test/nf3e/qrCode',
        resolvedIp: null,
        responseStatus: null,
        responseSha256: null,
      },
    })
  })

  it('mapeia HTTP não-200 para unavailable, preservando a auditoria', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf('<html>erro</html>', 503) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'unavailable',
      limitations: ['SOURCE_UNAVAILABLE'],
      errorCodes: ['SOURCE_UNAVAILABLE'],
      audit: {
        requestedUrl: 'https://fiscal.test/nf3e/qrCode',
        resolvedIp: '203.0.113.10',
        responseStatus: 503,
        responseSha256: sha256('<html>erro</html>'),
      },
    })
  })
})

describe('Nf3eFiscalAdapter — resposta', () => {
  it('documento encontrado com endereço/titular completos reutiliza as comparações existentes', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(FOUND_FULL) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'authentic',
      address: 'matches',
      holder: 'matches',
      limitations: [],
      errorCodes: [],
    })
  })

  it('resposta encontrada sem endereço/titular preserva not_extracted', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(FOUND_MINIMAL) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'authentic',
      address: 'not_extracted',
      holder: 'not_extracted',
    })
  })

  it('compara e devolve differs quando os campos fortes/titular divergem', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(FOUND_FULL) })
    const context: FiscalAdapterContext = {
      ...CONTEXT,
      claim: {
        address: {
          cep: '90010150',
          uf: 'RS',
          logradouroNorm: 'RUA DAS FLORES',
          numero: '999',
          bairroNorm: 'CENTRO',
          municipioNorm: 'PORTO ALEGRE',
          complementoNorm: null,
        },
        holder: { legalName: 'Outra Empresa Ltda', tradeName: null },
      },
    }

    const result = await adapter.verify(INPUT, context)

    expect(result).toMatchObject({
      document: 'authentic',
      address: 'differs',
      holder: 'differs',
    })
  })

  it('mapeia ausência determinística para not_found', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(NOT_FOUND) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'not_found',
      address: 'not_extracted',
      holder: 'not_extracted',
      limitations: [],
      errorCodes: [],
    })
  })

  it('mapeia erro claro de chave para invalid', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(INVALID_KEY) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'invalid',
      address: 'not_extracted',
      holder: 'not_extracted',
      limitations: [],
      errorCodes: [],
    })
  })

  it('mapeia resposta 200 não reconhecida para inconclusive, nunca invalid', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(UNRECOGNIZED) })

    const result = await adapter.verify(INPUT, CONTEXT)

    expect(result).toMatchObject({
      document: 'inconclusive',
      address: 'not_extracted',
      holder: 'not_extracted',
      limitations: ['ADAPTER_ERROR'],
      errorCodes: ['ADAPTER_ERROR'],
    })
  })

  it('não devolve resposta bruta, PII ou campos de scoring', async () => {
    const adapter = makeAdapter({ safeFetch: safeFetchOf(FOUND_FULL) })

    const result = await adapter.verify(INPUT, CONTEXT)
    const serialized = JSON.stringify(result)

    // `documentId` faz parte do contrato interno; o materializador persiste
    // apenas `document_ref_hash`. O que não pode vazar é a resposta bruta/PII.
    expect(serialized).not.toContain('Empresa Exemplo')
    expect(serialized).not.toContain('Rua das Flores')
    expect(serialized).not.toContain('90010-150')
    expect(serialized).not.toContain('12.345.678/0001-99')
    expect(serialized).not.toContain('<div')
    expect(serialized).not.toContain('trust_score')
    expect(serialized).not.toContain('final_score')
    expect(serialized).not.toContain('approved')
    expect(serialized).not.toContain('rejected')
  })
})

describe('parser da consulta SVRS', () => {
  it('lê somente a seção do destinatário', () => {
    const parsed = parseNf3eQrConsultationResponse(FOUND_FULL)

    expect(parsed).toMatchObject({
      status: 'found',
      holder: { name: 'Empresa Exemplo Ltda' },
      address: {
        logradouro: 'Rua das Flores',
        numero: '123',
        bairro: 'Centro',
        cidade: 'Porto Alegre',
        uf: 'RS',
        cep: '90010-150',
      },
    })
    if (parsed.status !== 'found') throw new Error('fixture deveria ser found')

    expect(JSON.stringify(parsed)).not.toContain('Energia Exemplo')
  })

  it('reconhece as mensagens de ausência e de chave inválida', () => {
    expect(parseNf3eQrConsultationResponse(NOT_FOUND)).toEqual({ status: 'not_found' })
    expect(parseNf3eQrConsultationResponse(INVALID_KEY)).toEqual({ status: 'invalid' })
    expect(parseNf3eQrConsultationResponse(UNRECOGNIZED)).toEqual({ status: 'unrecognized' })
  })

  it('não trata um wrapper sem seção do destinatário como encontrado', () => {
    expect(parseNf3eQrConsultationResponse('<div id="nf3eQrCode"></div>')).toEqual({
      status: 'unrecognized',
    })
  })
})
