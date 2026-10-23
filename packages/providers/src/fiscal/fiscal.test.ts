import {
  FiscalAdapterUnavailableError,
  emptyFiscalAudit,
  type FiscalAdapterContext,
  type FiscalLookupInput,
} from '@comprova/core'
import { describe, expect, it, vi } from 'vitest'
import { safeExternalFetch } from '../safe-fetch.js'
import {
  FISCAL_ENDPOINT_ALLOWLIST,
  FiscalEndpointNotAllowedError,
  makeFiscalEndpointAllowlist,
  safeFetchFiscalEndpoint,
  type FiscalEndpointRef,
} from './endpoint.js'
import { makeFakeFiscalAdapter } from './fake-fiscal-adapter.js'
import { fiscalVerificationResultSchema } from './schema.js'

const NOW = new Date('2026-10-23T12:00:00.000Z')

const INPUT: FiscalLookupInput = {
  source: 'nf3e',
  tenantId: '00000000-0000-4000-8000-000000000001',
  claimId: '00000000-0000-4000-8000-000000000002',
  documentId: '35261012345678000199660010000000011000000010',
  qrCodeUrl: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
  issuer: 'SVRS',
  uf: 'SP',
  artifact: {
    artifactId: '00000000-0000-4000-8000-000000000003',
    sha256: 'ab'.repeat(32),
  },
}

const CONTEXT: FiscalAdapterContext = {
  tenantId: INPUT.tenantId,
  claim: { address: null, holder: null },
  now: () => NOW,
}

describe('FakeFiscalAdapter', () => {
  it('suporta apenas a fonte configurada e devolve resultado determinístico', async () => {
    const adapter = makeFakeFiscalAdapter({
      source: 'nf3e',
      version: '1.0.0',
      document: 'authentic',
      address: 'matches',
      holder: 'not_extracted',
      issuer: 'SVRS',
    })

    expect(adapter.supports(INPUT)).toBe(true)
    expect(adapter.supports({ ...INPUT, source: 'nfag-e' })).toBe(false)

    const result = await adapter.verify(INPUT, CONTEXT)
    expect(result).toMatchObject({
      source: 'nf3e',
      adapterVersion: '1.0.0',
      method: 'official_qr_consultation',
      environment: 'local',
      document: 'authentic',
      address: 'matches',
      holder: 'not_extracted',
      issuer: 'SVRS',
      documentId: INPUT.documentId,
      issuedAt: null,
      observedAt: NOW,
      audit: emptyFiscalAudit(),
    })
    expect(result.artifact).toEqual(INPUT.artifact)
  })

  it('sinaliza indisponibilidade sem transformar em invalid', async () => {
    const adapter = makeFakeFiscalAdapter({
      document: 'invalid',
      unavailableReason: 'SEFAZ_TIMEOUT',
    })
    await expect(adapter.verify(INPUT, CONTEXT)).rejects.toBeInstanceOf(FiscalAdapterUnavailableError)
  })
})

describe('schema do resultado fiscal', () => {
  it('remove campos de scoring/veredito que o adapter não pode emitir', async () => {
    const adapter = makeFakeFiscalAdapter({ document: 'authentic', address: 'matches', holder: 'matches' })
    const raw = await adapter.verify(INPUT, CONTEXT)
    const parsed = fiscalVerificationResultSchema.parse({
      ...raw,
      trust_score: 0.99,
      final_score: 1,
      approved: true,
      rejected: false,
    })
    expect(parsed).not.toHaveProperty('trust_score')
    expect(parsed).not.toHaveProperty('final_score')
    expect(parsed).not.toHaveProperty('approved')
    expect(parsed).not.toHaveProperty('rejected')
  })

  it('rejeita saída sem dimensões obrigatórias', () => {
    expect(fiscalVerificationResultSchema.safeParse({ source: 'nf3e' }).success).toBe(false)
  })
})

describe('allowlist de endpoints fiscais', () => {
  const ref = (issuer: string | null): FiscalEndpointRef => ({
    source: 'nf3e',
    issuer,
    environment: 'production',
  })

  const allowlist = makeFiscalEndpointAllowlist([
    {
      source: 'nf3e',
      issuer: 'SVRS',
      environment: 'production',
      url: 'https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode',
    },
  ])

  it('resolve somente source + autorizador + ambiente cadastrados no servidor', () => {
    expect(allowlist.resolve(ref('svrs'))?.url).toBe('https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode')
    expect(allowlist.resolve(ref('SVRS '))?.url).toBe('https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode')
    expect(allowlist.resolve(ref('OUTRO'))).toBeNull()
    expect(allowlist.resolve(ref(null))).toBeNull()
    expect(allowlist.resolve({ source: 'nfag-e', issuer: 'SVRS', environment: 'production' })).toBeNull()
  })

  it('recusa endpoint sem https, com credenciais ou duplicado', () => {
    expect(() =>
      makeFiscalEndpointAllowlist([
        { source: 'nf3e', issuer: 'SVRS', environment: 'production', url: 'http://example.test' },
      ]),
    ).toThrow(/https/)
    expect(() =>
      makeFiscalEndpointAllowlist([
        {
          source: 'nf3e',
          issuer: 'SVRS',
          environment: 'production',
          url: 'https://user:pass@example.test',
        },
      ]),
    ).toThrow(/credenciais/)
    expect(() =>
      makeFiscalEndpointAllowlist([
        {
          source: 'nf3e',
          issuer: 'SVRS',
          environment: 'production',
          url: 'https://example.test/a',
        },
        {
          source: 'nf3e',
          issuer: 'svrs',
          environment: 'production',
          url: 'https://example.test/b',
        },
      ]),
    ).toThrow(/duplicado/)
  })

  it('não chama o fetch quando o endpoint não está na allowlist', async () => {
    const safeFetch = vi.fn()
    await expect(safeFetchFiscalEndpoint({ allowlist, ref: ref('OUTRO'), safeFetch })).rejects.toBeInstanceOf(
      FiscalEndpointNotAllowedError,
    )
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('delega à guarda única usando a URL da allowlist, nunca a URL do QR', async () => {
    const safeFetch = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: Buffer.from('ok'),
      address: '203.0.113.10',
    }))
    const response = await safeFetchFiscalEndpoint({
      allowlist,
      ref: ref('SVRS'),
      safeFetch,
      options: { allowedContentTypes: ['text/html'], timeoutMs: 5_000 },
    })
    expect(response.status).toBe(200)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(safeFetch).toHaveBeenCalledWith('https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode', {
      allowedContentTypes: ['text/html'],
      timeoutMs: 5_000,
    })
    expect(JSON.stringify(safeFetch.mock.calls)).not.toContain('169.254.169.254')
  })

  it('mantém a defesa de SSRF mesmo se a allowlist apontar para metadata/RFC1918', async () => {
    const metadata = makeFiscalEndpointAllowlist([
      {
        source: 'nf3e',
        issuer: 'METADATA',
        environment: 'production',
        url: 'https://169.254.169.254/latest/meta-data',
      },
    ])
    await expect(
      safeFetchFiscalEndpoint({ allowlist: metadata, ref: ref('METADATA'), safeFetch: safeExternalFetch }),
    ).rejects.toMatchObject({ reason: 'METADATA_IP' })

    const privateAddress = makeFiscalEndpointAllowlist([
      {
        source: 'nf3e',
        issuer: 'PRIVATE',
        environment: 'production',
        url: 'https://10.0.0.1/nf3e',
      },
    ])
    await expect(
      safeFetchFiscalEndpoint({
        allowlist: privateAddress,
        ref: ref('PRIVATE'),
        safeFetch: safeExternalFetch,
      }),
    ).rejects.toMatchObject({ reason: 'PRIVATE_IP' })
  })

  it('nasce vazia: nenhuma fonte fiscal real está habilitada em F2.1', () => {
    expect(FISCAL_ENDPOINT_ALLOWLIST.resolve(ref('SVRS'))).toBeNull()
  })
})
