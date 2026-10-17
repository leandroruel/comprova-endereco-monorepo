import { generateKeyPairSync, sign as ed25519Sign, type KeyObject } from 'node:crypto'

/**
 * Assinador mínimo (FASE 8): sua única responsabilidade é assinar bytes. Não
 * conhece issuer, storage, VC nem banco. Implementação de desenvolvimento:
 * Ed25519 via `node:crypto` (sem dependência nova).
 */
export interface Signer {
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

export interface Ed25519KeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
}

export const generateEd25519KeyPair = (): Ed25519KeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey, privateKey }
}

export const makeEd25519Signer = (privateKey: KeyObject): Signer => ({
  sign: async (bytes) => ed25519Sign(null, bytes, privateKey),
})
