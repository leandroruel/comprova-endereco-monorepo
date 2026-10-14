import type { PlacesProvider, Poi } from './types.js'

export interface OverpassOptions {
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

interface OverpassElement {
  readonly type?: string
  readonly id?: number
  readonly lat?: number
  readonly lon?: number
  readonly tags?: Readonly<Record<string, string>>
}

const nameOf = (element: OverpassElement): string | null =>
  element.tags?.['name'] ?? element.tags?.['brand'] ?? element.tags?.['operator'] ?? null

const categoriesOf = (element: OverpassElement): readonly string[] =>
  Object.entries(element.tags ?? {})
    .filter(
      ([key]) =>
        key === 'amenity' || key === 'shop' || key === 'office' || key === 'craft' || key === 'tourism',
    )
    .map(([key, value]) => `${key}=${value}`)

export const makeOverpassPlaces = (options: OverpassOptions = {}): PlacesProvider => {
  const baseUrl = options.baseUrl ?? 'https://overpass-api.de/api/interpreter'
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000

  return {
    id: 'osm_overpass',
    findNearbyPois: async (point, radiusM, limit) => {
      const query = `[out:json][timeout:10];(node(around:${radiusM},${point.lat},${point.lon})["name"];way(around:${radiusM},${point.lat},${point.lon})["name"];);out center ${limit};`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(`${baseUrl}?data=${encodeURIComponent(query)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        })
        if (res.status !== 200) return []
        const body = (await res.json()) as { elements?: readonly OverpassElement[] }
        return (body.elements ?? [])
          .map((element): Poi | null => {
            const lat = element.lat
            const lon = element.lon
            if (lat === undefined || lon === undefined) return null
            return {
              name: nameOf(element),
              lat,
              lon,
              categories: categoriesOf(element),
            }
          })
          .filter((poi): poi is Poi => poi !== null)
          .slice(0, limit)
      } catch {
        return []
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
