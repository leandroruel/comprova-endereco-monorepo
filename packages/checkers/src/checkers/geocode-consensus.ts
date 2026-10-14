import type { CnefeCoordReader } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import type { GeocodeProvider } from '@comprova/providers'
import { haversineMeters } from '@comprova/providers'
import { makeSignal } from '../utils.js'

const ID = 'geocode_consensus'
const VERSION = '1.0.0'
const SOURCE = 'osm_nominatim+ibge:cnefe'
const TTL = 30 * 86_400

export const makeGeocodeConsensus = (geocoder: GeocodeProvider, cnefeCoords: CnefeCoordReader): Checker => ({
  id: ID,
  version: VERSION,
  tier: 1,
  appliesTo: ['CNPJ', 'CPF'],
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
    const [geocoded, cnefeCoord] = await Promise.all([
      geocoder.geocode({
        street: address.logradouroNorm,
        numero: address.numero ?? '',
        bairro: address.bairroNorm ?? null,
        municipio: null,
        uf: address.uf ?? null,
        cep: address.cep ?? null,
        countryCode: address.country ?? 'BR',
      }),
      cnefeCoords.coordFor({
        municipioIbge: address.municipioIbge,
        logradouroNorm: address.logradouroNorm,
        numero: address.numero ?? '',
      }),
    ])

    if (geocoded === null && cnefeCoord === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.5,
          detail: { reason: 'no_geocode', providers: [geocoder.id, 'cnefe'] },
        }),
      ]
    }
    if (geocoded === null || cnefeCoord === null) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: 0.3,
          confidence: 0.6,
          detail: {
            single_provider: geocoded === null ? 'cnefe' : geocoder.id,
            precision: geocoded?.precision ?? 'APPROXIMATE',
          },
        }),
      ]
    }
    const dispersion = haversineMeters(geocoded.point, cnefeCoord)
    if (dispersion <= 100) {
      return [
        makeSignal({
          ...base,
          stance: 'supports',
          strength: 0.5,
          confidence: 0.8,
          detail: {
            dispersion_m: Math.round(dispersion),
            precision: geocoded.precision,
            lat: Number(cnefeCoord.lat.toFixed(6)),
            lon: Number(cnefeCoord.lon.toFixed(6)),
          },
        }),
      ]
    }
    if (dispersion > 500) {
      return [
        makeSignal({
          ...base,
          stance: 'contradicts',
          strength: 0.4,
          confidence: 0.6,
          detail: { reason: 'providers_disagree', dispersion_m: Math.round(dispersion) },
        }),
      ]
    }
    return [
      makeSignal({
        ...base,
        stance: 'neutral',
        strength: 0.3,
        confidence: 0.6,
        detail: { dispersion_m: Math.round(dispersion), precision: geocoded.precision },
      }),
    ]
  },
})
