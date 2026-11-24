import { sha256Of, type EvidenceObjectStore } from '../types.js'

export const makeFakeObjectStore = (): EvidenceObjectStore => {
  const stored = new Map<string, Uint8Array>()
  return {
    put: async (key, data) => {
      stored.set(key, Uint8Array.from(data))
      return {
        key,
        uri: `memory://${key}`,
        sha256: sha256Of(data),
        bytes: data.byteLength,
      }
    },
    get: async (key) => {
      const data = stored.get(key)
      return data === undefined ? null : Uint8Array.from(data)
    },
    delete: async (key) => {
      stored.delete(key)
    },
  }
}
