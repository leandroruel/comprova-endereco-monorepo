import type { CnaeCategoria, CnaeCategoriaReader } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import { findSignalByChecker } from '../utils.js'
import { makeSignal } from '../utils.js'

const ID = 'cnae_vs_location'
const VERSION = '1.0.0'
const SOURCE = 'cnae:categoria'
const TTL = 90 * 86_400

const divisaoOf = (cnae: string | null): string | null =>
  cnae !== null && cnae.length >= 2 ? cnae.slice(0, 2) : null

export const makeCnaeVsLocation = (categorias: CnaeCategoriaReader): Checker => ({
  id: ID,
  version: VERSION,
  tier: 0,
  appliesTo: ['CNPJ'],
  timeoutMs: 20,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => {
    const base = {
      checkerId: ID,
      checkerVersion: VERSION,
      source: SOURCE,
      observedAt: ctx.clock.now().toISOString(),
      ttlSeconds: TTL,
    }
    const cnae = ctx.registryRecord?.cnaePrincipal ?? null
    const divisao = divisaoOf(cnae)
    if (divisao === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.3,
          detail: { reason: 'no_cnae' },
        }),
      ]
    }
    const categoria: CnaeCategoria = await categorias.categoriaForDivisao(divisao)
    const cnefeSignal = findSignalByChecker(ctx.priorSignals, 'cnefe_match')
    const residentialHint = cnefeSignal !== null && cnefeSignal.detail['residential_hint'] === true

    if ((categoria === 'INDUSTRIAL' || categoria === 'AGRICULTURAL') && residentialHint) {
      return [
        makeSignal({
          ...base,
          stance: 'contradicts',
          strength: 0.5,
          confidence: 0.6,
          detail: { divisao, categoria, residential_hint: true },
        }),
      ]
    }
    if (categoria === 'RESIDENTIAL_COMPATIBLE' && residentialHint) {
      return [
        makeSignal({
          ...base,
          stance: 'supports',
          strength: 0.4,
          confidence: 0.7,
          detail: { divisao, categoria, residential_hint: true, verdict_hint: 'RESIDENTIAL' },
        }),
      ]
    }
    return [
      makeSignal({
        ...base,
        stance: 'neutral',
        strength: 0.2,
        confidence: 0.5,
        detail: { divisao, categoria },
      }),
    ]
  },
})
