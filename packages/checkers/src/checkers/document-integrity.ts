import type { CheckContext, Checker, Signal } from '@comprova/core'
import { makeSignal } from '../utils.js'

const ID = 'document_integrity'
const VERSION = '1.0.0'
const SOURCE = 'core:doc-validation'
const TTL = 365 * 86_400

export const documentIntegrity: Checker = {
  id: ID,
  version: VERSION,
  tier: 0,
  appliesTo: ['CNPJ', 'CPF'],
  timeoutMs: 10,
  run: async (ctx: CheckContext): Promise<readonly Signal[]> => [
    makeSignal({
      checkerId: ID,
      checkerVersion: VERSION,
      stance: ctx.subject.docDigitsValid ? 'supports' : 'contradicts',
      strength: ctx.subject.docDigitsValid ? 0.5 : 0.9,
      confidence: 1,
      source: SOURCE,
      observedAt: ctx.clock.now().toISOString(),
      ttlSeconds: TTL,
      detail: ctx.subject.docDigitsValid ? {} : { reason: 'checksum_invalid' },
    }),
  ],
}
