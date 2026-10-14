export interface GeoPoint {
  readonly lat: number
  readonly lon: number
}

export type GeoPrecision = 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE' | 'NONE'

export interface GeocodeResult {
  readonly point: GeoPoint
  readonly precision: GeoPrecision
  readonly label: string | null
}

export interface GeocodeQuery {
  readonly street: string
  readonly numero: string
  readonly bairro: string | null
  readonly municipio: string | null
  readonly uf: string | null
  readonly cep: string | null
  readonly countryCode: string
}

export interface GeocodeProvider {
  readonly id: string
  readonly geocode: (query: GeocodeQuery) => Promise<GeocodeResult | null>
}

export interface Poi {
  readonly name: string | null
  readonly lat: number
  readonly lon: number
  readonly categories: readonly string[]
}

export interface PlacesProvider {
  readonly id: string
  readonly findNearbyPois: (point: GeoPoint, radiusM: number, limit: number) => Promise<readonly Poi[]>
}

export const haversineMeters = (a: GeoPoint, b: GeoPoint): number => {
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const R = 6_371_000
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const latA = toRad(a.lat)
  const latB = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
