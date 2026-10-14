import type { CepRecord } from '@comprova/core'

export interface BrasilApiCepOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly baseUrl?: string
}

export interface BrasilApiCepResponse {
  readonly cep: string
  readonly state: string | null
  readonly city: string | null
  readonly neighborhood: string | null
  readonly street: string | null
  readonly ibge: { readonly city: string | null; readonly state: string | null } | null
  readonly location: {
    readonly coordinates: { readonly latitude: string; readonly longitude: string } | null
  } | null
}

export const makeBrasilApiCep = (options: BrasilApiCepOptions = {}) => {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 8_000
  const baseUrl = options.baseUrl ?? 'https://brasilapi.com.br/api/cep/v2'

  return {
    id: 'brasilapi',
    get: async (cep: string): Promise<CepRecord | null> => {
      const clean = cep.replace(/\D+/g, '')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(`${baseUrl}/${clean}`, { signal: controller.signal })
        if (res.status === 404) return null
        if (res.status === 429) throw new Error('brasilapi rate limit')
        if (res.status !== 200) return null
        const body = (await res.json()) as BrasilApiCepResponse
        if (body.state === null) return null
        const municipioIbge = body.ibge !== null && body.ibge.city !== null ? Number(body.ibge.city) : null
        return {
          uf: body.state,
          municipioIbge,
          localidade: body.city,
          bairro: body.neighborhood,
          logradouroNorm: body.street,
        }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
