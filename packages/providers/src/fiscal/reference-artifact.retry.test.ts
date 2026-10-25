import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type * as ZxingReader from 'zxing-wasm/reader'

const decoderInit = vi.hoisted(() => ({ calls: 0 }))

/**
 * Falha a primeira inicialização do WASM e deixa a segunda passar. É a
 * regressão do cache de promessa rejeitada: sem o reset em `ensureQrReader`,
 * a segunda extração continuaria retornando `QR_DECODER_UNAVAILABLE`.
 */
vi.mock('zxing-wasm/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof ZxingReader>()
  return {
    ...actual,
    prepareZXingModule: async (options: unknown) => {
      decoderInit.calls += 1
      if (decoderInit.calls === 1) throw new Error('wasm init failed')
      return (actual.prepareZXingModule as (value: unknown) => Promise<unknown>)(options)
    },
  }
})

const NF3E_KEY = '35261012345678000199660010000000011000000015'

const fixture = (name: string): Uint8Array => {
  const buf = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

describe('F2.2b — retry da inicialização do decoder', () => {
  it('não cacheia a falha e permite uma nova tentativa', async () => {
    const { extractFiscalReferenceFromArtifact } = await import('./reference.js')

    const first = await extractFiscalReferenceFromArtifact({
      data: fixture('qr-nf3e.png'),
      contentType: 'image/png',
    })

    expect(first.status).toBe('inconclusive')
    expect(first.errorCodes).toContain('QR_DECODER_UNAVAILABLE')
    expect(decoderInit.calls).toBe(1)

    const second = await extractFiscalReferenceFromArtifact({
      data: fixture('qr-nf3e.png'),
      contentType: 'image/png',
    })

    expect(second.status).toBe('found')
    expect(second.documentId).toBe(NF3E_KEY)
    expect(second.errorCodes).toEqual([])
    expect(decoderInit.calls).toBe(2)
  })
})
