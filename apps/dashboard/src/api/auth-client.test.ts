import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Teste que reproduz o "404 silencioso" no login do dashboard admin.
 *
 * Usa o `authClient` REAL (criado em `./auth.ts`) com `fetch` mockado.
 * Isso captura o comportamento real do better-auth client, não um mock
 * artificial do módulo.
 *
 * Cenário: `VITE_DASHBOARD_ADMIN_AUTH_URL` não está definida →
 * `resolveAdminAuthBaseUrl()` retorna `''` → `authClient` criado com
 * `baseURL: ''`. No navegador, o better-auth resolve a base URL a partir
 * de `window.location.origin` + `/api/auth` (default path).
 *
 * Se o `signIn.email` chamar fetch para uma URL SEM `/api/auth`, o proxy
 * do Vite (que captura apenas `/api/auth/*`) não encaminha para o backend
 * (porta 3000) e a requisição cai no servidor dev (porta 5173) → 404.
 *
 * Além disso, se o servidor retornar 404 e `result.error` for falsy,
 * o `handleSubmit` do LoginPage não lança erro e chama `onSuccess()`
 * sem o usuário estar logado → "404 silencioso".
 *
 * O header `Origin` NÃO é mais forçado no client: o navegador não permite
 * defini-lo via JS e ele já é enviado automaticamente pelo próprio browser
 * (o `fetchOptions.onRequest` com `origin` foi revertido no isolamento de
 * cookies entre instâncias do Better Auth).
 */
describe('authClient real com fetch mockado (reprodução do 404)', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockFetch.mockClear()

    // Simula ambiente de navegador
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'http://localhost:5173' } },
      writable: true,
      configurable: true,
    })
    // Mock do fetch (customFetchImpl: fetch do better-auth)
    Object.defineProperty(globalThis, 'fetch', {
      value: mockFetch,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    // Restaura o fetch original (se houver) e remove o window mockado
    ;(globalThis as unknown as { fetch?: typeof fetch }).fetch = undefined
    ;(globalThis as unknown as { window?: Window }).window = undefined
  })

  it('signIn.email chama fetch com URL que inclui /api/auth (caminho do proxy Vite)', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'abc',
          session: {},
          user: { id: '1', email: 'a@b.com', name: 'A', role: 'admin' },
        }),
        { status: 200 },
      ),
    )

    const { authClient } = await import('./auth')

    await authClient.signIn.email({
      email: 'leandro.ruel@gmail.com',
      password: 'SenhaForte123!',
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url] = mockFetch.mock.calls[0] ?? []
    const urlStr = url ? String(url) : ''

    // O proxy do Vite captura apenas /api/auth/* → backend porta 3000.
    // Se a URL não tiver /api/auth, cai no servidor dev (5173) → 404.
    expect(urlStr).toContain('/api/auth/sign-in/email')
  })

  it('sign-in 404 com error = { status: 404 } (sem message) → erro capturado, não silencioso', async () => {
    // Simula servidor retornando 404 com body vazio
    mockFetch.mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }))

    const { authClient } = await import('./auth')

    const result = await authClient.signIn.email({
      email: 'leandro.ruel@gmail.com',
      password: 'SenhaForte123!',
    })

    // Se result.error for truthy (mesmo sem message), o handleSubmit lança erro
    // e o catch mostra 'Login falhou'. Não é silencioso.
    // Se result.error for falsy, o handleSubmit chama onSuccess() sem login = silencioso.
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(404)
  })
})
