import { describe, expect, it } from 'vitest'
import {
  detectDocumentContentType,
  normalizeDocumentContentType,
  validateDocumentContent,
  DocumentContentError,
  DOCUMENT_CONTENT_TYPES,
} from '../../src/services/document-content.js'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
const GARBAGE = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])

const expectCode = (fn: () => unknown, code: DocumentContentError['code']): void => {
  try {
    fn()
    expect.unreachable('deveria ter lançado DocumentContentError')
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentContentError)
    expect((error as DocumentContentError).code).toBe(code)
  }
}

describe('detectDocumentContentType — magic bytes', () => {
  it('detecta PDF, JPEG e PNG pelo conteúdo', () => {
    expect(detectDocumentContentType(PDF)).toBe('application/pdf')
    expect(detectDocumentContentType(JPEG)).toBe('image/jpeg')
    expect(detectDocumentContentType(PNG)).toBe('image/png')
  })

  it('retorna null para conteúdo desconhecido ou curto demais', () => {
    expect(detectDocumentContentType(GARBAGE)).toBe(null)
    expect(detectDocumentContentType(Uint8Array.from([0x89, 0x50]))).toBe(null)
    expect(detectDocumentContentType(new Uint8Array(0))).toBe(null)
  })
})

describe('normalizeDocumentContentType', () => {
  it('normaliza case, parâmetros e o alias image/jpg', () => {
    expect(normalizeDocumentContentType('IMAGE/PNG')).toBe('image/png')
    expect(normalizeDocumentContentType('image/jpeg; charset=binary')).toBe('image/jpeg')
    expect(normalizeDocumentContentType('image/jpg')).toBe('image/jpeg')
    expect(normalizeDocumentContentType(undefined)).toBe(null)
    expect(normalizeDocumentContentType('')).toBe('')
  })
})

describe('validateDocumentContent', () => {
  const MAX = 1024

  it('aceita tipos da allowlist e devolve o tipo detectado', () => {
    expect(validateDocumentContent(PDF, 'application/pdf', MAX)).toBe('application/pdf')
    expect(validateDocumentContent(PNG, undefined, MAX)).toBe('image/png')
    expect(validateDocumentContent(JPEG, 'image/jpg', MAX)).toBe('image/jpeg')
  })

  it('aceita Content-Type genérico e usa o tipo detectado', () => {
    expect(validateDocumentContent(PNG, 'application/octet-stream', MAX)).toBe('image/png')
    expect(validateDocumentContent(PNG, '', MAX)).toBe('image/png')
  })

  it('rejeita vazio, grande demais e desconhecido', () => {
    expectCode(() => validateDocumentContent(new Uint8Array(0), undefined, MAX), 'EMPTY')
    expectCode(() => validateDocumentContent(new Uint8Array(MAX + 1), undefined, MAX), 'TOO_LARGE')
    expectCode(() => validateDocumentContent(GARBAGE, undefined, MAX), 'UNSUPPORTED')
  })

  it('rejeita Content-Type declarado fora da allowlist mesmo com conteúdo válido', () => {
    expectCode(() => validateDocumentContent(PNG, 'text/plain', MAX), 'UNSUPPORTED')
    expectCode(() => validateDocumentContent(PNG, 'image/webp', MAX), 'UNSUPPORTED')
  })

  it('rejeita incompatibilidade entre declarado e detectado', () => {
    expectCode(() => validateDocumentContent(PDF, 'image/png', MAX), 'CONTENT_MISMATCH')
    expectCode(() => validateDocumentContent(PNG, 'application/pdf', MAX), 'CONTENT_MISMATCH')
  })

  it('allowlist contém exatamente PDF, JPEG e PNG (WebP fora)', () => {
    expect([...DOCUMENT_CONTENT_TYPES]).toEqual(['application/pdf', 'image/jpeg', 'image/png'])
  })
})
