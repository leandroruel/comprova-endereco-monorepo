/**
 * Worker proxy para o dashboard Comprova.
 *
 * - Rotas /api/* são encaminhadas para a API externa (Render), injetando
 *   o header Authorization com a API_KEY secreta do Worker.
 * - Demais rotas servem os assets estáticos do build do Vite.
 *
 * O segredo API_KEY nunca chega ao browser: vive apenas no ambiente do Worker.
 */

// `API_BASE` e `DASHBOARD_ORIGIN` vêm do ambiente do Worker (wrangler [vars]).
// Assim a URL da API e a origem permitida não ficam fixas no código.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // --- Proxy da API ---
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return proxyToApi(request, env)
    }

    // --- Assets estáticos ---
    // Para rotas da SPA (ex: /organizations, /validations) que não existem
    // como arquivo estático, servimos o index.html e deixamos o React Router
    // do Vite cuidar da navegação no lado do cliente. Sem isso, um refresh
    // em /organizations retorna 404 do Cloudflare.
    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404) {
      return assetResponse
    }

    // Fallback SPA: serve o conteúdo do index.html com status 200, mantendo a
    // URL original no navegador para que o React Router renderize a rota
    // correta (ex: /organizations) em vez de redirecionar para /.
    const indexUrl = new URL('/index.html', url.origin)
    const indexResponse = await fetch(indexUrl.toString(), {
      method: 'GET',
      headers: request.headers,
      redirect: 'manual',
    })

    // O Cloudflare Assets redireciona /index.html para / (307). Seguimos
    // manualmente para obter o conteúdo real.
    let finalResponse = indexResponse
    if (indexResponse.status === 307 || indexResponse.status === 308) {
      const location = indexResponse.headers.get('location') ?? '/'
      finalResponse = await fetch(new URL(location, url.origin).toString(), {
        method: 'GET',
        headers: request.headers,
      })
    }

    return new Response(finalResponse.body, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=0, must-revalidate',
      },
    })
  },

  /**
   * Keep-warm da API no Render (plano free): sem tráfego por 15 minutos a
   * instância desliga e o próximo usuário espera ~1 minuto de cold start
   * (muitas vezes visto como 502/timeout no proxy). O cron de 5 minutos
   * (`[triggers]` no wrangler.toml) dispara este handler e um GET barato em
   * `/healthz` (resposta estática, sem banco) basta para zerar o contador de
   * inatividade.
   *
   * Custo: ~288 requisições/dia contra o limite de 100 mil do plano free do
   * Workers. Contrapartida: a instância passa a consumir ~720 h/mês das 750 h
   * free do Render — com um único serviço free na conta, cabe, mas não sobra
   * margem para um segundo serviço 24/7.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      fetch(`${env.API_BASE}/healthz`)
        .then((res) => {
          console.log(`[keep-warm] /healthz -> ${res.status}`)
        })
        .catch((err: unknown) => {
          console.log(`[keep-warm] falhou: ${err instanceof Error ? err.message : String(err)}`)
        }),
    )
  },
} satisfies ExportedHandler<Env>

/**
 * Converte o caminho público do dashboard para o caminho da API.
 *
 * O frontend usa `/api` como base (`VITE_API_URL=/api`) e `/api/auth` para
 * o Better Auth. A API expõe os dados em `/v1/*` e o auth admin em
 * `/v1/auth/admin/*`, então o prefixo `/api` é removido aqui, no Worker.
 */
function toUpstreamPath(pathname: string): string {
  const authPrefix = '/api/auth'
  if (pathname === authPrefix || pathname.startsWith(`${authPrefix}/`)) {
    return `/v1/auth/admin${pathname.slice(authPrefix.length)}`
  }
  return pathname.slice('/api'.length) || '/'
}

/**
 * Encaminha a requisição para a API externa, injetando Authorization.
 */
async function proxyToApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  // Valida a origem da requisição (anti-proxy aberto)
  const allowedOrigin = env.DASHBOARD_ORIGIN
  const origin = request.headers.get('Origin') ?? ''
  const referer = request.headers.get('Referer') ?? ''
  const isAllowedOrigin =
    allowedOrigin.length > 0 &&
    (origin === allowedOrigin || referer.startsWith(allowedOrigin))

  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({ error: 'Acesso não autorizado' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Constrói a URL alvo na API externa
  const targetUrl = `${env.API_BASE}${toUpstreamPath(url.pathname)}${url.search}`

  // Monta os headers para a chamada upstream. O Content-Type original é
  // preservado: uploads multipart não podem ser reescritos como JSON.
  // A Origin/Referer é preservada para que a API resolva a sessão do
  // dashboard (admin x verifier) e valide CORS/trustedOrigins.
  const upstreamHeaders = new Headers(request.headers)
  upstreamHeaders.set('Authorization', `Bearer ${env.API_KEY}`)
  upstreamHeaders.delete('host')

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
