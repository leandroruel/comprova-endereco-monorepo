/**
 * Primitivas de encoding usadas pelo proof Data Integrity:
 * JSON Canonicalization Scheme (RFC 8785) e base58btc + Multibase.
 *
 * As duas implementações são locais e sem dependências novas. Elas não conhecem
 * issuer, VC, banco ou rede: recebem bytes/valores JSON e devolvem a forma
 * canônica/codificada.
 */

/**
 * JSON Canonicalization Scheme (JCS) — RFC 8785.
 *
 * É o canonicalizador NORMATIVO do material assinado pela cryptosuite
 * `eddsa-jcs-2022` (W3C Data Integrity EdDSA Cryptosuites v1.0, §3.3.3 e
 * §3.3.5): o que se assina é `JCS(proofConfig) || JCS(documento sem proof)`.
 *
 * Regras (RFC 8785 §3.2):
 *  - nenhum whitespace entre tokens;
 *  - primitivos serializados como no ECMAScript `JSON.stringify`
 *    (`Number::toString` para números, `QuoteJSONString` para strings);
 *  - `NaN`/`Infinity` não existem em JSON: abortam a canonicalização;
 *  - propriedades de objeto ordenadas pelos code units UTF-16 da chave;
 *  - a ordem de arrays é significativa.
 *
 * Papel na arquitetura (ver ADR-0020): este pacote tem DOIS níveis de
 * representação e cada um tem o seu canonicalizador.
 *  - assertion interna da Comprova → `canonicalJson` (`@comprova/core`,
 *    ADR-0017), usado pelo `evidence_set_hash`;
 *  - documento W3C (VC) → `canonicalize` (RFC 8785), exigido pela Data
 *    Integrity. Mesma família de regras, finalidades e normas distintas.
 */
export class JcsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JcsError'
  }
}

const byUtf16CodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Serializa um valor JSON na forma canônica do RFC 8785. Total sobre o
 * subconjunto de valores JSON (objeto, array, string, número finito, booleano,
 * `null`); qualquer outro valor levanta `JcsError`.
 */
export const canonicalize = (value: unknown): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new JcsError(`JCS cannot serialize the non-finite number ${String(value)}`)
      }
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(byUtf16CodeUnits)
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      return `{${members.join(',')}}`
    }
    default:
      throw new JcsError(`JCS cannot serialize a value of type ${typeof value}`)
  }
}

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
