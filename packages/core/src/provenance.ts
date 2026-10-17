import { createHash } from 'node:crypto'

/**
 * Binding determinístico do conjunto de observações (claim_evidence) usado por
 * um resultado de validation. Este NÃO é um mecanismo de assinatura (SSI/VC):
 * é apenas a base durável e reproduzível para que uma credencial possa, no
 * futuro, referenciar "qual conjunto de evidências" produziu a asserção.
 *
 * Regras de canonicalização (ver ADR-0017):
 *  - ordena as observações por identificador estável (`id`), independente da
 *    ordem em que vieram do PostgreSQL;
 *  - serializa cada observação como um array JSON de campos relevantes;
 *  - canonicaliza `detail` recursivamente (chaves ordenadas), pois `jsonb`
 *    normaliza/serializa objetos sem ordem garantida;
 *  - usa `evidenceSha256` (durável) e NUNCA `evidence_id` (efêmero), para que o
 *    hash continue reproduzível após a retenção do material físico.
 */
export interface EvidenceSetEntry {
  readonly id: string
  readonly checker: string
  readonly checkerVersion: string
  readonly stance: string
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: string
  readonly evidenceSha256: string | null
  readonly detail: unknown
}

/**
 * Canonicalização JSON determinística usada por este módulo e reutilizada pela
 * camada de emissão de credenciais (`@comprova/credential`), para que o material
 * assinado seja reproduzível pelo mesmo algoritmo que produz `evidence_set_hash`.
 *
 * Propriedades: ordena chaves de objetos recursivamente; preserva a ordem de
 * arrays; descarta propriedades de objeto com valor `undefined`; serializa
 * `null` (e `undefined` em posição de valor) como `null`; usa `JSON.stringify`
 * para primitivos. Total sobre o subconjunto de valores JSON.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const canonicalEvidenceSet = (entries: readonly EvidenceSetEntry[]): string =>
  [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) =>
      canonicalJson([
        e.id,
        e.checker,
        e.checkerVersion,
        e.stance,
        e.strength,
        e.confidence,
        e.source,
        e.observedAt,
        e.evidenceSha256,
        e.detail,
      ]),
    )
    .join('\n')

export const evidenceSetHash = (entries: readonly EvidenceSetEntry[]): string =>
  createHash('sha256').update(canonicalEvidenceSet(entries), 'utf8').digest('hex')

/** Linha persistida de `claim_evidence` no formato necessário ao hash. */
export interface ObservationRow {
  readonly id: string
  readonly checker: string
  readonly checkerVersion: string
  readonly stance: string
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: Date | string
  readonly evidenceSha256: Uint8Array | null
  readonly detail: unknown
}

const toHex = (value: Uint8Array | null): string | null =>
  value === null ? null : Buffer.from(value).toString('hex')

export const evidenceSetHashOfObservations = (rows: readonly ObservationRow[]): string =>
  evidenceSetHash(
    rows.map((row) => ({
      id: row.id,
      checker: row.checker,
      checkerVersion: row.checkerVersion,
      stance: row.stance,
      strength: row.strength,
      confidence: row.confidence,
      source: row.source,
      observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt,
      evidenceSha256: toHex(row.evidenceSha256),
      detail: row.detail,
    })),
  )
