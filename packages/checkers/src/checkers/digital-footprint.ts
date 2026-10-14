import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'digital_footprint'
const VERSION = '1.0.0'
const SOURCE = 'receita:estabelecimentos+ddd-map'
const TTL = 90 * 86_400

const DDD_TO_UF: Readonly<Record<string, readonly string[]>> = {
  ES: ['27', '28'],
  MG: ['31', '32', '33', '34', '35', '37', '38'],
  RJ: ['21', '22', '24'],
  SP: ['11', '12', '13', '14', '15', '16', '17', '18', '19'],
  PR: ['41', '42', '43', '44', '45', '46'],
  SC: ['47', '48', '49'],
  RS: ['51', '53', '54', '55'],
  AC: ['68'],
  AL: ['82'],
  AM: ['92', '97'],
  AP: ['96'],
  BA: ['71', '73', '74', '75', '77'],
  CE: ['85', '88'],
  DF: ['61'],
  GO: ['62', '64'],
  MA: ['98', '99'],
  MS: ['67'],
  MT: ['65', '66'],
  PA: ['91', '93', '94'],
  PB: ['83'],
  PE: ['81', '87'],
  PI: ['86', '89'],
  RN: ['84'],
  RO: ['69'],
  RR: ['95'],
  SE: ['79'],
  TO: ['63'],
}

const dddOf = (telefone: string | null): string | null => {
  if (telefone === null) return null
  const digits = telefone.replace(/\D+/g, '')
  return digits.length >= 10 ? digits.slice(-10, -8) : null
}

const ufsForDdd = (ddd: string): readonly string[] =>
  Object.entries(DDD_TO_UF)
    .filter(([, ddds]) => ddds.includes(ddd))
    .map(([uf]) => uf)

export const digitalFootprint: Checker = {
  id: ID,
  version: VERSION,
  tier: 1,
  appliesTo: ['CNPJ'],
  timeoutMs: 5_000,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const base = {
      checkerId: ID,
      checkerVersion: VERSION,
      source: SOURCE,
      observedAt: ctx.clock.now().toISOString(),
      ttlSeconds: TTL,
    }
    const record = ctx.registryRecord
    if (record === undefined) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'no_registry' },
        }),
      ]
    }

    const ddd = dddOf(record.telefone)
    const uf = record.uf
    if (ddd !== null && uf !== null) {
      const ufs = ufsForDdd(ddd)
      const detail: Record<string, unknown> = { ddd, uf, has_email_domain: record.emailDomain !== null }
      if (ufs.includes(uf)) {
        return [makeSignal({ ...base, stance: 'supports', strength: 0.2, confidence: 0.8, detail })]
      }
      if (ufs.length > 0) {
        return [
          makeSignal({
            ...base,
            stance: 'contradicts',
            strength: 0.3,
            confidence: 0.7,
            detail: { ...detail, expected_ufs: [...ufs] },
          }),
        ]
      }
      return [makeSignal({ ...base, stance: 'neutral', strength: 0.1, confidence: 0.5, detail })]
    }

    return [
      makeSignal({
        ...base,
        stance: 'unknown',
        strength: 0,
        confidence: 0.4,
        detail: { reason: 'no_phone_data' },
      }),
    ]
  },
}
