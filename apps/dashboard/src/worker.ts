/**
 * Worker proxy para o dashboard Comprova.
 *
 * - Rotas /api/* são encaminhadas para a API externa (Render), injetando
 *   o header Authorization com a API_KEY secreta do Worker.
 * - Demais rotas servem os assets estáticos do build do Vite.
 *
 * O segredo API_KEY nunca chega ao browser: vive apenas no ambiente do Worker.
 */

const API_BASE = 'https://comprova-api.onrender.com'

// Origens permitidas para o proxy (evita que o Worker vire API aberta)
const ALLOWED_ORIGINS = [
  'https://comprova-dashboard.leandro-ruel.workers.dev',
]

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // --- Proxy da API ---
    if (url.pathname.startsWith('/api/')) {
      return proxyToApi(request, env)
    }

    // --- Assets estáticos ---
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

/**
 * Encaminha a requisição para a API externa, injetando Authorization.
 */
async function proxyToApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  // Valida a origem da requisição (anti-proxy aberto)
  const origin = request.headers.get('Origin') ?? ''
  const referer = request.headers.get('Referer') ?? ''
  const isAllowedOrigin =
    ALLOWED_ORIGINS.includes(origin) ||
    ALLOWED_ORIGINS.some((o) => referer.startsWith(o))

  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({ error: 'Acesso não autorizado' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Constrói a URL alvo na API externa
  const targetUrl = `${API_BASE}${url.pathname}${url.search}`

  // Monta os headers para a chamada upstream
  const upstreamHeaders = new Headers(request.headers)
  upstreamHeaders.set('Authorization', `Bearer ${env.API_KEY}`)
  upstreamHeaders.set('Content-Type', 'application/json')
  upstreamHeaders.delete('host')
  upstreamHeaders.delete('origin')
  upstreamHeaders.delete('referer')

  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : request.body

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body,
    })

    // Repassa a resposta do upstream
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-length') // o corpo pode mudar de tamanho

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  } catch {
    return new Response(
      JSON.stringify({ error: 'Erro ao comunicar com a API' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
