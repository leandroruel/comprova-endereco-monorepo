/**
 * Extração e limpeza do token do Holder na URL pública.
 *
 * Formato aceito:
 *   /holder/hlt_...
 *
 * O token vem no segmento de caminho da rota pública. Após capturá-lo em
 * memória, ele é removido da barra de endereço com `history.replaceState` para
 * não permanecer na URL nem ser enviado como `Referer`.
 */

export const HOLDER_ACCESS_PATH_PREFIX = '/holder/'

const TOKEN_PREFIX = 'hlt_'

export const isHolderAccessPath = (pathname: string): boolean => {
  const segments = pathname.split('/').filter(Boolean)
  return segments.length === 2 && segments[0] === 'holder' && isHolderTokenLike(segments[1])
}

const parse = (href: string): URL => new URL(href, 'http://holder.local')

export const isHolderTokenLike = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length

export const extractHolderToken = (href: string): string | null => {
  const url = parse(href)
  if (!isHolderAccessPath(url.pathname)) return null

  // O token é o último segmento do caminho: /holder/hlt_...
  const segments = url.pathname.split('/').filter(Boolean)
  const token = segments[segments.length - 1]

  return isHolderTokenLike(token) ? token : null
}

/**
 * Devolve a URL sem o segmento do token, mantendo o restante do caminho.
 */
export const cleanHolderUrl = (href: string): string => {
  const url = parse(href)

  const segments = url.pathname.split('/').filter(Boolean)
  // Remove o último segmento se for um token
  if (segments.length > 0 && isHolderTokenLike(segments[segments.length - 1])) {
    segments.pop()
  }

  const search = url.searchParams.toString()
  const hash = url.hash
  const path = segments.length > 0 ? `/${segments.join('/')}` : '/'
  return `${path}${search.length > 0 ? `?${search}` : ''}${hash}`
}

/**
 * Captura o token e limpa a URL. Retorna `null` fora da rota pública ou quando
 * o link não contém token.
 */
export const consumeHolderTokenFromLocation = (): string | null => {
  if (typeof window === 'undefined') return null
  const token = extractHolderToken(window.location.href)
  if (token !== null) {
    window.history.replaceState(window.history.state, '', cleanHolderUrl(window.location.href))
  }
  return token
}
