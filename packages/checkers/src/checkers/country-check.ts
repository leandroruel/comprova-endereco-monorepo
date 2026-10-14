import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'country_check'
const VERSION = '1.0.0'
const SOURCE = 'receita:estabelecimentos'
const TTL = 30 * 86_400
const BRASIL_PAIS_CODIGO = 105

export const countryCheck: Checker = {
  id: ID,
  version: VERSION,
  tier: 0,
  appliesTo: ['CNPJ', 'CPF'],
  timeoutMs: 10,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const record = ctx.registryRecord
    const exterior =
      record !== undefined &&
      ((record.paisCodigo !== null && record.paisCodigo !== BRASIL_PAIS_CODIGO) ||
        record.cidadeExterior !== null)
    if (exterior) {
      return [
        makeSignal({
          checkerId: ID,
          checkerVersion: VERSION,
          stance: 'neutral',
          strength: 0.9,
          confidence: 0.95,
          source: SOURCE,
          observedAt: ctx.clock.now().toISOString(),
          ttlSeconds: TTL,
          detail: {
            verdict_hint: 'FOREIGN',
            pais_codigo: record?.paisCodigo ?? null,
            cidade_exterior: record?.cidadeExterior ?? null,
          },
        }),
      ]
    }
    if (record?.uf !== null && record?.uf !== undefined && record.uf.length === 2) {
      return [
        makeSignal({
          checkerId: ID,
          checkerVersion: VERSION,
          stance: 'supports',
          strength: 0.2,
          confidence: 0.9,
          source: SOURCE,
          observedAt: ctx.clock.now().toISOString(),
          ttlSeconds: TTL,
          detail: { country: 'BR', uf: record.uf },
        }),
      ]
    }
    return [
      makeSignal({
        checkerId: ID,
        checkerVersion: VERSION,
        stance: 'unknown',
        strength: 0,
        confidence: 0.5,
        source: SOURCE,
        observedAt: ctx.clock.now().toISOString(),
        ttlSeconds: TTL,
        detail: { country: 'BR' },
      }),
    ]
  },
}
