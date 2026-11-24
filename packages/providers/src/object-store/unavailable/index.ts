import { type EvidenceObjectStore } from '../types.js'

/**
 * Store fail-closed para quando o object storage não foi configurado. Evita
 * cair silenciosamente em memória em produção: o intake responde 503 e nada é
 * aceito. Testes injetam um store explícito no `buildApp`.
 */
export const makeUnavailableObjectStore = (
  reason = 'object storage is not configured',
): EvidenceObjectStore => ({
  put: async () => {
    throw new Error(reason)
  },
  get: async () => {
    throw new Error(reason)
  },
  delete: async () => {
    throw new Error(reason)
  },
})
