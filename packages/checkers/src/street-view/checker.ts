import type { CheckContext, Checker, GeoCoord, Signal } from '@comprova/core'
import type { StreetViewProvider, StreetViewResult, VisionModel } from '@comprova/providers'
import { findSignalByChecker, makeSignal } from '../utils.js'

const ID = 'street_view_vlm'
const VERSION = `1.0.0+${'facade-v1'}`
const SOURCE = 'google_street_view+vlm'
const TTL = 90 * 86_400
const MAX_AGE_MONTHS = 60
const MIN_AGE_FACTOR = 0.3

export interface EvidenceRecord {
  readonly evidenceId: string
}

export type EvidenceWriter = (evidence: {
  readonly kind: 'street_view_image' | 'vlm_output'
  readonly provider: string
  readonly data: Uint8Array
  readonly contentType: string
  readonly capturedAt: Date | null
  readonly retentionDays: number
  readonly detail: Record<string, unknown>
}) => Promise<string>

export interface StreetViewVlmDeps {
  readonly streetView: StreetViewProvider
  readonly vision: VisionModel
  readonly evidenceWriter?: EvidenceWriter
  readonly storeImages?: boolean
}

const coordFromSignal = (signal: Signal): GeoCoord | null => {
  const lat = signal.detail['lat']
  const lon = signal.detail['lon']
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null
}

const ageFactor = (capturedAt: Date | null, now: Date): number => {
  if (capturedAt === null) return 0.5
  const months = Math.max(0, (now.getTime() - capturedAt.getTime()) / (30.44 * 86_400_000))
  return Math.min(1, Math.max(MIN_AGE_FACTOR, 1 - months / MAX_AGE_MONTHS))
}

const pointOf = (ctx: CheckContext): GeoCoord | null => {
  const geocode = findSignalByChecker(ctx.priorSignals, 'geocode_consensus')
  const fromGeocode = geocode !== null ? coordFromSignal(geocode) : null
  if (fromGeocode !== null) return fromGeocode
  const cnefe = findSignalByChecker(ctx.priorSignals, 'cnefe_match')
  return cnefe !== null ? coordFromSignal(cnefe) : null
}

export const makeStreetViewVlm = (deps: StreetViewVlmDeps): Checker => ({
  id: ID,
  version: VERSION,
  tier: 2,
  appliesTo: ['CNPJ', 'CPF'],
  timeoutMs: 60_000,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const now = ctx.clock.now()
    const base = {
      checkerId: ID,
      checkerVersion: VERSION,
      source: SOURCE,
      observedAt: now.toISOString(),
      ttlSeconds: TTL,
    }
    const point = pointOf(ctx)
    if (point === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'no_point' },
        }),
      ]
    }
    const view: StreetViewResult = await deps.streetView.getStreetView(point)
    if (view.status !== 'IMAGE_AVAILABLE' || view.image === undefined) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: view.status === 'NO_IMAGE' ? 0.6 : 0.3,
          detail: { reason: view.status === 'NO_IMAGE' ? 'no_imagery' : 'provider_unavailable' },
        }),
      ]
    }

    const evidenceIds: string[] = []
    if (deps.storeImages === true && deps.evidenceWriter !== undefined) {
      const imageEvidenceId = await deps.evidenceWriter({
        kind: 'street_view_image',
        provider: view.attribution ?? deps.streetView.id,
        data: view.image,
        contentType: 'image/jpeg',
        capturedAt: view.capturedAt ?? null,
        retentionDays: 180,
        detail: { lat: point.lat, lon: point.lon },
      })
      evidenceIds.push(imageEvidenceId)
    }

    try {
      const classification = await deps.vision.classifyFacade(view.image)
      if (deps.evidenceWriter !== undefined) {
        const outputEvidenceId = await deps.evidenceWriter({
          kind: 'vlm_output',
          provider: deps.vision.id,
          data: Buffer.from(JSON.stringify(classification), 'utf8'),
          contentType: 'application/json',
          capturedAt: view.capturedAt ?? null,
          retentionDays: 365,
          detail: { prompt_version: 'facade-v1', model: deps.vision.version },
        })
        evidenceIds.push(outputEvidenceId)
      }

      const factor = ageFactor(view.capturedAt ?? null, now)
      const confidence = Math.min(1, classification.confidence * factor)
      const evidenceId = evidenceIds.length > 0 ? evidenceIds[evidenceIds.length - 1] : undefined
      const common = {
        ...base,
        confidence,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      }
      const imageDate = view.capturedAt !== undefined ? view.capturedAt.toISOString().slice(0, 10) : null
      const evidenceIdsDetail: Record<string, unknown> =
        evidenceIds.length > 0 ? { evidence_ids: [...evidenceIds] } : {}

      if (classification.klass === 'COMMERCIAL') {
        const other = classification.other_business_name
        const fantasia = ctx.registryRecord?.nomeFantasia ?? null
        const matches =
          other === null || fantasia === null
            ? null
            : other.toUpperCase().includes(fantasia.toUpperCase()) ||
              fantasia.toUpperCase().includes(other.toUpperCase())
        if (other !== null && matches === false) {
          return [
            makeSignal({
              ...common,
              stance: 'contradicts',
              strength: 0.6,
              detail: {
                facade: 'commercial_other_name',
                other_business_name: other,
                image_date: imageDate,
                ...evidenceIdsDetail,
              },
            }),
          ]
        }
        return [
          makeSignal({
            ...common,
            stance: 'supports',
            strength: 0.6,
            detail: {
              facade: 'commercial',
              other_business_name: other,
              image_date: imageDate,
              ...evidenceIdsDetail,
            },
          }),
        ]
      }
      if (classification.klass === 'RESIDENTIAL') {
        return [
          makeSignal({
            ...common,
            stance: 'contradicts',
            strength: 0.5,
            detail: { facade: 'residential', image_date: imageDate, ...evidenceIdsDetail },
          }),
        ]
      }
      if (classification.klass === 'VACANT_LOT' || classification.klass === 'CONSTRUCTION') {
        return [
          makeSignal({
            ...common,
            stance: 'contradicts',
            strength: 0.6,
            detail: {
              facade: classification.klass.toLowerCase(),
              image_date: imageDate,
              ...evidenceIdsDetail,
            },
          }),
        ]
      }
      if (classification.klass === 'CONDOMINIUM') {
        return [
          makeSignal({
            ...common,
            stance: 'neutral',
            strength: 0.3,
            detail: { facade: 'condominium', image_date: imageDate, ...evidenceIdsDetail },
          }),
        ]
      }
      return [
        makeSignal({
          ...common,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'vlm_unknown', image_date: imageDate, ...evidenceIdsDetail },
        }),
      ]
    } catch {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.2,
          detail: { reason: 'vlm_unavailable' },
        }),
      ]
    }
  },
})
