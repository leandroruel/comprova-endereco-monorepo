/**
 * base58btc + Multibase (prefixo `z`).
 *
 * A Data Integrity exige que `proof.proofValue` seja "base-encoded" com
 * cabeçalho e alfabeto Multibase (W3C VC Data Integrity 1.0 §2.1 e W3C VC DI
 * EdDSA §2.2.1). Para a cryptosuite `eddsa-jcs-2022` o cabeçalho é base58-btc
 * (`z`), como no vetor normativo B.3. Implementação local, sem base58btc nem
 * multiformats (nenhuma dependência nova).
 */
export class MultibaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultibaseError'
  }
}

const BASE58_BTC_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_BTC_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE58_BTC_ALPHABET].map((char, index) => [char, index]),
)

/** Cabeçalho Multibase do alfabeto base58-btc. */
export const MULTIBASE_BASE58_BTC_HEADER = 'z'

export const base58BtcEncode = (bytes: Uint8Array): string => {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)

  let encoded = ''
  while (value > 0n) {
    encoded = BASE58_BTC_ALPHABET[Number(value % 58n)]! + encoded
    value /= 58n
  }

  // Cada byte zero à esquerda vira um '1' (o zero do alfabeto base58).
  let zeros = 0
  for (const byte of bytes) {
    if (byte !== 0) break
    zeros += 1
  }
  return `${'1'.repeat(zeros)}${encoded}`
}

export const base58BtcDecode = (text: string): Uint8Array => {
  let value = 0n
  for (const char of text) {
    const digit = BASE58_BTC_INDEX.get(char)
    if (digit === undefined) {
      throw new MultibaseError(`invalid base58btc character: ${JSON.stringify(char)}`)
    }
    value = value * 58n + BigInt(digit)
  }

  const bytes: number[] = []
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn))
    value >>= 8n
  }

  let zeros = 0
  for (const char of text) {
    if (char !== '1') break
    zeros += 1
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes])
}

export const encodeMultibaseBase58Btc = (bytes: Uint8Array): string =>
  `${MULTIBASE_BASE58_BTC_HEADER}${base58BtcEncode(bytes)}`

export const decodeMultibaseBase58Btc = (text: string): Uint8Array => {
  if (!text.startsWith(MULTIBASE_BASE58_BTC_HEADER)) {
    throw new MultibaseError(
      `expected a base58btc Multibase value starting with "${MULTIBASE_BASE58_BTC_HEADER}"`,
    )
  }
  return base58BtcDecode(text.slice(MULTIBASE_BASE58_BTC_HEADER.length))
}
