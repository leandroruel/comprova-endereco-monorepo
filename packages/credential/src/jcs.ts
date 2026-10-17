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
