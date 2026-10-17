import { canonicalJson } from '@comprova/core'
import type { AssertionPayload } from './assertion.js'

const encoder = new TextEncoder()

/**
 * Representação canônica da assertion (FASE 4): o material exato que é assinado.
 *
 * Usa o MESMO canonicalizador do `evidence_set_hash` (`canonicalJson` do
 * `@comprova/core`), garantindo que o conjunto de evidências embutido na
 * credencial seja reproduzível pelo algoritmo que o gerou. Propriedades:
 * ordenação de chaves independente da ordem de inserção em JS, ordem de arrays
 * preservada, `null`/`undefined` → `null`, independente de ordem de resultados
 * de SQL (as observações são ordenadas antes de montar o payload).
 *
 * O `proof` fica fora do material assinado.
 */
export const canonicalAssertion = (payload: AssertionPayload): string => canonicalJson(payload)

export const canonicalAssertionBytes = (payload: AssertionPayload): Uint8Array =>
  encoder.encode(canonicalAssertion(payload))
