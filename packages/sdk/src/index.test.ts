import { describe, expect, it } from 'vitest'
import { createClient, SdkError } from './index.js'

const fakeFetch = (
  handler: (url: string, init?: { body?: string }) => { status: number; body: unknown },
): typeof fetch =>
  (async (url: string, init?: { body?: string }) => {
    const res = handler(url, init)
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

const options = {
  baseUrl: 'http://api.test',
  apiKey: 'cvktest',
}

describe('sdk client', () => {
  it('createValidation posta o corpo correto e devolve o DTO', async () => {
    const client = createClient({
      ...options,
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toBe('http://api.test/v1/validations')
        const body = JSON.parse(init?.body ?? '{}')
        expect(body.document.type).toBe('CNPJ')
        return {
          status: 200,
          body: {
            validation_id: 'v-1',
            status: 'completed',
            verdict: 'CONFIRMED_COMMERCIAL',
            confidence: 0.89,
            score: 0.98,
            policy_version: '2026.12.1',
            address: null,
            signals: [],
            explanation: 'ok',
            created_at: '2026-10-14T00:00:00Z',
            expires_at: '2026-11-13T00:00:00Z',
          },
        }
      }),
    })
    const result = await client.createValidation({
      document: { type: 'CNPJ', value: '12345678000195' },
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    })
    expect(result.verdict).toBe('CONFIRMED_COMMERCIAL')
  })

  it('erros de dominio viram SdkError com code', async () => {
    const client = createClient({
      ...options,
      fetchImpl: fakeFetch(() => ({ status: 422, body: { code: 'INVALID_DOCUMENT' } })),
    })
    await expect(
      client.createValidation({
        document: { type: 'CNPJ', value: '11111111111111' },
        legal_basis: 'FRAUD_PREVENTION',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_DOCUMENT' })
  })

  it('erasure do subject usa DELETE e devolve contagem', async () => {
    const client = createClient({
      ...options,
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe('http://api.test/v1/subjects/s-1')
        return { status: 200, body: { erased: true, validations_removed: 2 } }
      }),
    })
    const result = await client.eraseSubject('s-1')
    expect(result.validations_removed).toBe(2)
    void SdkError
  })
})
