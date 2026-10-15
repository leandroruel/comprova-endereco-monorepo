import type { CepReader } from '@comprova/core'
import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'cep_consistency'
const VERSION = '1.0.0'
const SOURCE = 'ref:cep'
const TTL = 180 * 86_400

export const makeCepConsistency = (cep: CepReader): Checker => ({
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
    const record = ctx.registryRecord
    const cepValue = record?.cep ?? ctx.address?.cep ?? null
    if (cepValue === null || cepValue.length !== 8) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { reason: 'cep_missing' },
        }),
      ]
    }
    const cepRecord = await cep.get(cepValue)
    if (cepRecord === null) {
      return [
        makeSignal({
          ...base,
          stance: 'unknown',
          strength: 0,
          confidence: 0.4,
          detail: { reason: 'cep_not_in_local_db' },
        }),
      ]
    }
    const uf = record?.uf ?? ctx.address?.uf ?? null
    if (uf !== null && cepRecord.uf.toUpperCase() !== uf.toUpperCase()) {
      return [
        makeSignal({
          ...base,
          stance: 'contradicts',
          strength: 0.8,
          confidence: 0.9,
          detail: { reason: 'uf_mismatch', cep_uf: cepRecord.uf, document_uf: uf },
        }),
      ]
    }
    const logradouroNorm = ctx.address?.logradouroNorm ?? null
    const sameStreet =
      logradouroNorm === null ||
      cepRecord.logradouroNorm === null ||
      cepRecord.logradouroNorm === '' ||
      cepRecord.logradouroNorm.toUpperCase() === logradouroNorm.toUpperCase() ||
      cepRecord.logradouroNorm.toUpperCase().includes(logradouroNorm.toUpperCase()) ||
      logradouroNorm.toUpperCase().includes(cepRecord.logradouroNorm.toUpperCase())
    if (!sameStreet) {
      return [
        makeSignal({
          ...base,
          stance: 'neutral',
          strength: 0.4,
          confidence: 0.6,
          detail: {
            reason: 'street_mismatch',
            cep_logradouro: cepRecord.logradouroNorm,
            document_logradouro: logradouroNorm,
          },
        }),
      ]
    }
    return [
      makeSignal({
        ...base,
        stance: 'supports',
        strength: 0.6,
        confidence: 0.9,
        detail: { cep: cepValue, uf: cepRecord.uf, localidade: cepRecord.localidade },
      }),
    ]
  },
})
