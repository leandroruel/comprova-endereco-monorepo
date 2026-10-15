import type { CnefeReader } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'cnefe_match'
const VERSION = '1.0.0'
const SOURCE = 'ibge:cnefe'
const TTL = 180 * 86_400

const RESIDENTIAL_ESPECIES: ReadonlySet<number> = new Set([1, 2])

export const makeCnefeMatch = (cnefe: CnefeReader): Checker => ({
  id: ID,
  version: VERSION,
  tier: 0,
  appliesTo: ['CNPJ', 'CPF'],
  timeoutMs: 200,
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
    const match = await cnefe.findAddress({
      municipioIbge: address.municipioIbge,
      logradouroNorm: address.logradouroNorm,
      numero: address.numero ?? '',
    })
    if (match === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { match: 'none' },
        }),
      ]
    }
    const residential = match.especie !== null && RESIDENTIAL_ESPECIES.has(match.especie)
    const cpfResidentialHint = residential && match.exactNumber && ctx.subject.docType === 'CPF'
    const detail: Record<string, unknown> = {
      match: match.exactNumber ? 'exact_number' : 'street_only',
      cnefe_id: match.cnefeId,
      ...(match.especie !== null ? { especie: match.especie } : {}),
      ...(residential ? { residential_hint: true } : {}),
      ...(cpfResidentialHint ? { verdict_hint: 'RESIDENTIAL' } : {}),
    }
    if (match.exactNumber) {
      return [makeSignal({ ...base, stance: 'supports', strength: 0.6, confidence: 0.9, detail })]
    }
    return [makeSignal({ ...base, stance: 'neutral', strength: 0.3, confidence: 0.6, detail })]
  },
})
