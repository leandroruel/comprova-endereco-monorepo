import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Teste que valida as correções do fluxo de login do dashboard admin:
 * 1. A URL do signIn.email inclui /api/auth (caminho do proxy Vite)
 * 2. O header Origin é definido para evitar 403 CSRF do better-auth
 */
describe('authClient admin sign-in (fetch mockado)', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockFetch.mockClear()

    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'http://localhost:5173' } },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'fetch', {
      value: mockFetch,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    ;(globalThis as unknown as { fetch?: typeof fetch }).fetch = undefined
    ;(globalThis as unknown as { window?: Window }).window = undefined
  })

  it('signIn.email chama fetch com URL /api/auth/sign-in/email e header Origin', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ token: 'abc', session: {}, user: { id: '1', email: 'a@b.com', name: 'A', role: 'admin' } }), { status: 200 })
    )

    const { authClient } = await import('./auth')

    await authClient.signIn.email({
      email: 'leandro.ruel@gmail.com',
      password: 'SenhaForte123!',
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const call = mockFetch.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call!
    const urlStr = String(url)
    console.log('Fetch URL:', urlStr)
    console.log('Fetch init headers:', init?.headers)

    // 1. URL deve incluir /api/auth (caminho do proxy Vite)
    expect(urlStr).toContain('/api/auth/sign-in/email')

    // 2. Header Origin deve ser definido (evita 403 CSRF)
    const headers = init?.headers as Headers | Record<string, string> | undefined
    const origin = headers instanceof Headers ? headers.get('origin') : headers?.origin
    console.log('Origin header:', origin)
    expect(origin).toBe('http://localhost:5173')
  })
})
