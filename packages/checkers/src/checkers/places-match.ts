import type { CnefeCoordReader, GeoCoord } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import type { PlacesProvider } from '@comprova/providers'
import { findSignalByChecker, makeSignal } from '../utils.js'

const ID = 'places_match'
const VERSION = '1.0.0'
const SOURCE = 'osm_overpass'
const TTL = 30 * 86_400
const RADIUS_M = 60
const MAX_POIS = 10

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const nameSimilarity = (a: string, b: string): boolean => {
  const na = normalize(a)
  const nb = normalize(b)
  if (na.length < 3 || nb.length < 3) return false
  return na.includes(nb) || nb.includes(na)
}

const coordFromSignal = (signal: Signal): GeoCoord | null => {
  const lat = signal.detail['lat']
  const lon = signal.detail['lon']
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null
}

export const makePlacesMatch = (places: PlacesProvider, cnefeCoords: CnefeCoordReader): Checker => ({
  id: ID,
  version: VERSION,
  tier: 1,
  appliesTo: ['CNPJ'],
  timeoutMs: 20_000,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const base = {
      checkerId: ID,
      checkerVersion: VERSION,
      source: SOURCE,
      observedAt: ctx.clock.now().toISOString(),
      ttlSeconds: TTL,
    }
    const address = ctx.address
    if (address === null || address.municipioIbge === undefined || address.logradouroNorm === undefined) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'address_not_resolved' },
        }),
      ]
    }
    const geocode = findSignalByChecker(ctx.priorSignals, 'geocode_consensus')
    const point =
      (geocode !== null ? coordFromSignal(geocode) : null) ??
      (await cnefeCoords.coordFor({
        municipioIbge: address.municipioIbge,
        logradouroNorm: address.logradouroNorm,
        numero: address.numero ?? '',
      }))
    if (point === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { reason: 'no_point' },
        }),
      ]
    }

    const pois = await places.findNearbyPois(point, RADIUS_M, MAX_POIS)
    if (pois.length === 0) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { reason: 'no_pois', radius_m: RADIUS_M },
        }),
      ]
    }
    const nomeFantasia = ctx.registryRecord?.nomeFantasia ?? null
    const match =
      nomeFantasia !== null
        ? pois.find((poi) => poi.name !== null && nameSimilarity(poi.name, nomeFantasia))
        : undefined
    if (match !== undefined && match.name !== null) {
      return [
        makeSignal({
          ...base,
          stance: 'supports',
          strength: 0.6,
          confidence: 0.7,
          detail: { matched_poi: match.name, poi_categories: [...match.categories], radius_m: RADIUS_M },
        }),
      ]
    }
    if (nomeFantasia !== null) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: 0.4,
          confidence: 0.6,
          detail: {
            reason: 'poi_present_name_mismatch',
            nearby_pois: pois
              .filter((p) => p.name !== null)
              .map((p) => p.name)
              .slice(0, 3),
          },
        }),
      ]
    }
    return [
      makeSignal({
        ...base,
        stance: 'neutral',
        strength: 0.2,
        confidence: 0.5,
        detail: { nearby_poi_count: pois.length },
      }),
    ]
  },
})
