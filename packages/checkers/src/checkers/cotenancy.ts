import type { KnownSharedReader, ProfileReader } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'cotenancy'
const VERSION = '2.0.0'
const SOURCE = 'receita:address_profile'
const TTL = 7 * 86_400

const SHARED_MIN_ACTIVE = 8
const SHARED_MIN_CNAE_DIV = 5
const OCCUPIED_MAX_OTHERS = 3

const sameUnitOf = (ctx: CheckContext): boolean => {
  const unitKey = ctx.address?.unitKey
  const recordKey = ctx.registryRecord?.unitKey
  if (unitKey === undefined || recordKey === undefined || recordKey === null) return false
  return Buffer.from(unitKey).equals(recordKey)
}

export const makeCotenancy = (
  profile: ProfileReader,
  knownShared: KnownSharedReader,
  sharedThresholds: { readonly minActive: number; readonly minCnaeDiv: number } = {
    minActive: SHARED_MIN_ACTIVE,
    minCnaeDiv: SHARED_MIN_CNAE_DIV,
  },
): Checker => ({
  id: ID,
  version: VERSION,
  tier: 0,
  appliesTo: ['CNPJ'],
  timeoutMs: 25,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const base = {
      checkerId: ID,
      checkerVersion: VERSION,
      source: SOURCE,
      observedAt: ctx.clock.now().toISOString(),
      ttlSeconds: TTL,
    }
    const buildingKey = ctx.address?.buildingKey
    if (buildingKey === undefined || ctx.registryRecord === undefined) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'no_building_key' },
        }),
      ]
    }
    const sameUnit = sameUnitOf(ctx)

    const [profileRecord, sharedRecord] = await Promise.all([
      profile.getProfile(buildingKey),
      knownShared.get(buildingKey),
    ])
    if (profileRecord === null && sharedRecord === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { reason: 'no_profile' },
        }),
      ]
    }
    const activeCount = profileRecord?.activeCnpjCount ?? 0
    const cnaeDiv = profileRecord?.distinctCnaeDiv ?? 0
    const isKnownShared = sharedRecord !== null || (profileRecord?.isKnownShared ?? false)
    const isSharedVirtual =
      isKnownShared || (activeCount >= sharedThresholds.minActive && cnaeDiv >= sharedThresholds.minCnaeDiv)

    if (isSharedVirtual) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: sameUnit ? 0.5 : 0.7,
          confidence: 0.85,
          detail: {
            verdict_hint: 'SHARED_VIRTUAL',
            active_cnpj_count: activeCount,
            distinct_cnae_div: cnaeDiv,
            shared_kind: sharedRecord?.kind ?? profileRecord?.sharedKind ?? null,
            same_unit: sameUnit,
          },
        }),
      ]
    }

    const others = await profile.getOtherActiveCnpjs(buildingKey, ctx.registryRecord.cnpjBasico)

    if (!sameUnit && others.length >= 1 && others.length <= OCCUPIED_MAX_OTHERS) {
      return [
        makeSignal({
          ...base,
          stance: 'contradicts',
          strength: 0.7,
          confidence: 0.7,
          detail: {
            verdict_hint: 'OCCUPIED_BY_OTHER_ENTITY',
            other_active_cnpjs: others.length,
            other_names: others
              .map((o) => o.nomeFantasia ?? `${o.cnpjBasico}/${o.cnpjOrdem}`)
              .slice(0, OCCUPIED_MAX_OTHERS),
            same_unit: false,
          },
        }),
      ]
    }

    if (sameUnit && others.length >= 1 && others.length <= OCCUPIED_MAX_OTHERS) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: 0.3,
          confidence: 0.6,
          detail: {
            reason: 'same_unit_other_cnpjs',
            other_active_cnpjs: others.length,
            same_unit: true,
          },
        }),
      ]
    }

    if (others.length > OCCUPIED_MAX_OTHERS) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: 0.4,
          confidence: 0.7,
          detail: {
            verdict_hint: 'SHARED_VIRTUAL',
            active_cnpj_count: activeCount,
            other_active_cnpjs: others.length,
          },
        }),
      ]
    }

    return [
      makeSignal({
        ...base,
        stance: 'supports',
        strength: 0.4,
        confidence: 0.8,
        detail: { active_cnpj_count: Math.max(activeCount, 1), other_active_cnpjs: 0 },
      }),
    ]
  },
})
