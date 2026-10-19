import { createPublicKey, type KeyObject } from 'node:crypto'
import { decodeMultibaseBase58Btc, encodeMultibaseBase58Btc } from './multibase.js'

/**
 * Chave pública Ed25519 no formato `publicKeyMultibase` da W3C (Multikey):
 * `multibase(base58btc)( multicodec("ed25519-pub") || chave crua de 32 bytes )`.
 *
 * O prefixo multicodec `0xed 0x01` (varint) diz ao consumidor que os bytes
 * seguintes são uma chave Ed25519; sem ele, os 32 bytes crus não são
 * auto-descritivos. É o formato que a Data Integrity espera em
 * `publicKeyMultibase` e o que o ADR-0024 §2 antecipa para a publicação da
 * chave — nada proprietário, nenhuma dependência nova.
 */

/** multibase + multicodec `ed25519-pub`. */
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01])
/** Preâmbulo SPKI DER de uma chave Ed25519 (RFC 8410), sem os 32 bytes da chave. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PUBLIC_KEY_BYTES = 32

export class PublicKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicKeyError'
  }
}

/** Bytes crus da chave Ed25519 (32) a partir do `KeyObject`. */
const rawEd25519Of = (publicKey: KeyObject): Buffer => {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new PublicKeyError(`public key must be Ed25519 (got ${publicKey.asymmetricKeyType ?? 'unknown'})`)
  }
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const prefix = spki.subarray(0, ED25519_SPKI_PREFIX.length)
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length)
  if (!prefix.equals(ED25519_SPKI_PREFIX) || raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new PublicKeyError('unexpected Ed25519 SPKI encoding')
  }
  return raw
}

/**
 * Bytes crus da chave pública Ed25519 (32). É o formato sem autodescrição que o
 * banco guarda na coluna `public_key`; a descrição de tipo (`ed25519-pub`) entra
 * só na serialização pública (`publicKeyMultibase`).
 */
export const ed25519PublicKeyBytes = (publicKey: KeyObject): Buffer => rawEd25519Of(publicKey)

/** Reconstrói o `KeyObject` a partir dos 32 bytes crus (inverso do acima). */
export const ed25519PublicKeyFromBytes = (bytes: Uint8Array): KeyObject => {
  const raw = Buffer.from(bytes)
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new PublicKeyError(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`)
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

export const encodeEd25519PublicKeyMultibase = (publicKey: KeyObject): string =>
  encodeMultibaseBase58Btc(Buffer.concat([ED25519_MULTICODEC, rawEd25519Of(publicKey)]))

export const decodeEd25519PublicKeyMultibase = (value: string): KeyObject => {
  const bytes = Buffer.from(decodeMultibaseBase58Btc(value))
  const prefix = bytes.subarray(0, ED25519_MULTICODEC.length)
  if (!prefix.equals(ED25519_MULTICODEC)) {
    throw new PublicKeyError('multibase value does not start with the ed25519-pub multicodec prefix')
  }
  return ed25519PublicKeyFromBytes(bytes.subarray(ED25519_MULTICODEC.length))
}
