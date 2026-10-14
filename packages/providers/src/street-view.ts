import type { GeoPoint } from './types.js'

export type StreetViewStatus = 'IMAGE_AVAILABLE' | 'NO_IMAGE' | 'PROVIDER_UNAVAILABLE'

export interface StreetViewResult {
  readonly status: StreetViewStatus
  readonly image?: Uint8Array
  readonly capturedAt?: Date
  readonly attribution?: string
}

export interface StreetViewProvider {
  readonly id: string
  readonly getStreetView: (point: GeoPoint) => Promise<StreetViewResult>
}

export interface GoogleStreetViewOptions {
  readonly apiKey?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export const makeGoogleStreetView = (options: GoogleStreetViewOptions = {}): StreetViewProvider => {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  return {
    id: 'google_street_view',
    getStreetView: async (point) => {
      if (options.apiKey === undefined || options.apiKey === '') {
        return { status: 'PROVIDER_UNAVAILABLE' }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${point.lat},${point.lon}&radius=50&key=${options.apiKey}`
        const metaRes = await doFetch(metaUrl, { signal: controller.signal })
        if (metaRes.status !== 200) return { status: 'PROVIDER_UNAVAILABLE' }
        const meta = (await metaRes.json()) as { status?: string; date?: string }
        if (meta.status !== 'OK' || meta.date === undefined) {
          return { status: 'NO_IMAGE' }
        }
        const imageUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${point.lat},${point.lon}&radius=50&source=outdoor&key=${options.apiKey}`
        const imageRes = await doFetch(imageUrl, { signal: controller.signal })
        if (imageRes.status !== 200) return { status: 'PROVIDER_UNAVAILABLE' }
        const image = new Uint8Array(await imageRes.arrayBuffer())
        return {
          status: 'IMAGE_AVAILABLE',
          image,
          capturedAt: new Date(meta.date),
          attribution: 'Google Street View',
        }
      } catch {
        return { status: 'PROVIDER_UNAVAILABLE' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export const makeFakeStreetView = (resolve: () => StreetViewResult): StreetViewProvider => ({
  id: 'fake_street_view',
  getStreetView: async () => resolve(),
})
