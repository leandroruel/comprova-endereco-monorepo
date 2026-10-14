import type { PartnerGraphReader } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'partner_graph'
const VERSION = '1.0.0'
const SOURCE = 'receita:socios'
const TTL = 30 * 86_400

const SHARED_PARTNER_MIN_CN = 3
const BATCH_OPENING_MIN = 5

export const makePartnerGraph = (graph: PartnerGraphReader): Checker => ({
  id: ID,
  version: VERSION,
  tier: 1,
  appliesTo: ['CNPJ'],
  timeoutMs: 15_000,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const base = {
      checkerId: ID,
      checkerVersion: VERSION,
      source: SOURCE,
      observedAt: ctx.clock.now().toISOString(),
      ttlSeconds: TTL,
    }
    const buildingKey = ctx.address?.buildingKey
    const cnpjBasico = ctx.registryRecord?.cnpjBasico
    if (buildingKey === undefined || cnpjBasico === undefined) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'no_address_or_registry' },
        }),
      ]
    }
    const stats = await graph.statsFor({ buildingKey, cnpjBasico })
    if (!stats.hasData) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { reason: 'no_co_located_data' },
        }),
      ]
    }
    const facadePattern =
      stats.cnpjsSharingPartner >= SHARED_PARTNER_MIN_CN || stats.recentOpeningsAtAddress >= BATCH_OPENING_MIN
    if (facadePattern) {
      return [
        makeSignal({
          ...base,
          stance: 'contradicts',
          strength: 0.5,
          confidence: 0.6,
          detail: {
            cnpjs_sharing_partner: stats.cnpjsSharingPartner,
            recent_openings_at_address: stats.recentOpeningsAtAddress,
            co_located_cnpjs: stats.coLocatedCnpjs,
            pattern: 'partner_facade',
          },
        }),
      ]
    }
    if (stats.cnpjsSharingPartner > 0) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: 0.3,
          confidence: 0.6,
          detail: {
            cnpjs_sharing_partner: stats.cnpjsSharingPartner,
            recent_openings_at_address: stats.recentOpeningsAtAddress,
            co_located_cnpjs: stats.coLocatedCnpjs,
          },
        }),
      ]
    }
    return [
      makeSignal({
        ...base,
        stance: 'neutral',
        strength: 0.1,
        confidence: 0.6,
        detail: {
          co_located_cnpjs: stats.coLocatedCnpjs,
          recent_openings_at_address: stats.recentOpeningsAtAddress,
        },
      }),
    ]
  },
})
