import type { GeocodeProvider, GeocodeQuery, GeocodeResult } from './types.js'

export interface NominatimOptions {
  readonly baseUrl?: string
  readonly userAgent?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

const nominatimPrecisionOf = (raw: unknown): GeocodeResult['precision'] => {
  const category = typeof raw === 'string' ? raw : ''
  return category.includes('building') || category.includes('house')
    ? 'ROOFTOP'
    : category.includes('street')
      ? 'RANGE_INTERPOLATED'
      : 'GEOMETRIC_CENTER'
}

export const makeNominatimGeocoder = (options: NominatimOptions = {}): GeocodeProvider => {
  const baseUrl = options.baseUrl ?? 'https://nominatim.openstreetmap.org'
  const userAgent = options.userAgent ?? 'comprova-endereco-dev/0.1 (sideproject)'
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 8_000

  return {
    id: 'osm_nominatim',
    geocode: async (query: GeocodeQuery): Promise<GeocodeResult | null> => {
      const params = new URLSearchParams()
      params.set('format', 'jsonv2')
      params.set('addressdetails', '0')
      params.set('limit', '1')
      params.set(
        'q',
        [
          query.street,
          query.numero,
          query.bairro ?? '',
          query.municipio ?? '',
          query.uf ?? '',
          query.cep ?? '',
          query.countryCode === 'BR' ? 'Brasil' : '',
        ]
          .filter((part) => part.length > 0)
          .join(', '),
      )
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(`${baseUrl}/search?${params.toString()}`, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (res.status !== 200) return null
        const body = (await res.json()) as ReadonlyArray<{
          lat: string
          lon: string
          category?: string
          display_name?: string
        }>
        const first = body[0]
        if (first === undefined) return null
        return {
          point: { lat: Number(first.lat), lon: Number(first.lon) },
          precision: nominatimPrecisionOf(first.category ?? ''),
          label: first.display_name ?? null,
        }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
