import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = (name: string): Uint8Array => {
  const buf = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('F2.2b — isolamento de rede do extractor físico', () => {
  it('decodifica QR sem nenhuma chamada de fetch, mesmo com fetch envenenado no cold start', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network disabled in test')
    })
    vi.stubGlobal('fetch', fetchSpy)

    // Import tardio: garante que o decoder é inicializado DEPOIS de envenenar
    // fetch. Se o WASM tentasse CDN/locateFile, este teste falharia.
    const { extractFiscalReferenceFromArtifact } = await import('./reference.js')
    const reference = await extractFiscalReferenceFromArtifact({
      data: fixture('qr-nf3e.png'),
      contentType: 'image/png',
    })

    expect(reference.status).toBe('found')
    expect(reference.documentId).toBe('35261012345678000199660010000000011000000015')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['loopback http', 'qr-loopback-http.png', '127.0.0.1'],
    ['localhost', 'qr-localhost.png', 'localhost'],
    ['metadata link-local', 'qr-metadata.png', '169.254.169.254'],
    ['RFC1918', 'qr-private.png', '10.0.0.1'],
  ])('não transforma QR com %s em input de consulta', async (_name, file, forbidden) => {
    const { extractFiscalReferenceFromArtifact } = await import('./reference.js')
    const { toFiscalLookupInput } = await import('@comprova/core')

    const reference = await extractFiscalReferenceFromArtifact({
      data: fixture(file),
      contentType: 'image/png',
    })

    expect(reference.status).toBe('unsupported')
    expect(reference.errorCodes).toContain('UNSAFE_REFERENCE_URL')
    expect(reference.fingerprint).toBeNull()
    expect(
      toFiscalLookupInput(reference, { tenantId: 'tenant', claimId: 'claim', artifact: null }),
    ).toBeNull()
    // Nem a URL crua nem o payload do QR aparecem no contrato.
    expect(JSON.stringify(reference)).not.toContain(forbidden)
  })

  it('QR com conteúdo arbitrário não vira referência e não persiste o texto', async () => {
    const { extractFiscalReferenceFromArtifact } = await import('./reference.js')
    const reference = await extractFiscalReferenceFromArtifact({
      data: fixture('qr-arbitrary.png'),
      contentType: 'image/png',
    })

    expect(reference.status).toBe('not_found')
    expect(reference.fingerprint).toBeNull()
    expect(JSON.stringify(reference)).not.toContain('apenas texto')
  })
})
