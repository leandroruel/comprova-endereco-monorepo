import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'registry_status'
const VERSION = '1.0.0'
const SOURCE = 'receita:estabelecimentos'
const TTL = 30 * 86_400

const base = (ctx: CheckContext) => ({
  checkerId: ID,
  checkerVersion: VERSION,
  source: SOURCE,
  observedAt: ctx.clock.now().toISOString(),
  ttlSeconds: TTL,
})

export const registryStatus: Checker = {
  id: ID,
  version: VERSION,
  tier: 0,
  appliesTo: ['CNPJ'],
  timeoutMs: 200,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const record = ctx.registryRecord
    if (record === undefined) {
      return [
        makeSignal({
          ...base(ctx),
          stance: 'unknown',
          strength: 0,
          confidence: 0.5,
          detail: { reason: 'not_in_registry' },
        }),
      ]
    }
    const { situacaoCadastral, dataAbertura } = record
    const common = {
      ...base(ctx),
      confidence: 0.95,
      detail: { situacao: situacaoLabel(situacaoCadastral) },
    }
    if (situacaoCadastral === 2) {
      return [
        makeSignal({
          ...common,
          stance: 'supports',
          strength: 0.5,
          detail: {
            ...common.detail,
            ...(dataAbertura !== null ? { data_abertura: dataAbertura } : {}),
          },
        }),
      ]
    }
    if (situacaoCadastral === 8) {
      return [
        makeSignal({
          ...common,
          stance: 'contradicts',
          strength: 0.8,
          detail: { ...common.detail, verdict_hint: 'REGISTRY_DEFUNCT' },
        }),
      ]
    }
    if (situacaoCadastral === 4) {
      return [makeSignal({ ...common, stance: 'contradicts', strength: 0.6 })]
    }
    if (situacaoCadastral === 3) {
      return [makeSignal({ ...common, stance: 'neutral', strength: 0.3 })]
    }
    return [makeSignal({ ...common, stance: 'neutral', strength: 0.2 })]
  },
}

const situacaoLabel = (code: number): string =>
  (
    ({
      1: 'nula',
      2: 'ativa',
      3: 'suspensa',
      4: 'inapta',
      8: 'baixada',
    }) as Record<number, string>
  )[code] ?? 'desconhecida'
