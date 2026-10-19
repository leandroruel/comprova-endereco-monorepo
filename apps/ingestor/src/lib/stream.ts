/**
 * Motor de ingestão de CSV linha a linha, sem mutabilidade: consome um iterador
 * assíncrono em lotes (`takeAsync`), classifica cada lote com `parse` e grava com
 * `write`, acumulando as estatísticas por recursão. Substitui os `for(;;)` /
 * `for await` com `let` que existiam nos ingeridores, mantendo o consumo em
 * streaming (nunca bufferiza o arquivo inteiro).
 */
export interface LineIngestOptions<T> {
  readonly batchSize: number
  /** Para depois de gravar `limit` linhas válidas (não linhas lidas). */
  readonly limit?: number | undefined
  /** `null` marca a linha como descartada (contada em `skipped`). */
  readonly parse: (line: string) => T | null
  readonly write: (batch: readonly T[]) => Promise<void>
}

export interface LineIngestStats {
  readonly ingested: number
  readonly skipped: number
}

interface LineBatch<T> {
  readonly values: readonly T[]
  readonly skipped: number
}

/**
 * Lê até `n` linhas do iterador. Em vez de copiar o acumulador a cada linha
 * (custo quadrático dentro do lote), pede as `n` leituras e materializa o lote
 * uma única vez. Iteradores assíncronos (`readline`, async generators) atendem
 * `next()` concorrentes na ordem em que foram pedidos, preservando a ordem.
 */
export const takeAsync = async <T>(iterator: AsyncIterator<T>, n: number): Promise<readonly T[]> => {
  const results = await Promise.all(Array.from({ length: n }, () => iterator.next()))
  return results.flatMap((result) => (result.done === true ? [] : [result.value]))
}

/** Drena o iterador inteiro para um array. Para fontes pequenas (ex.: municípios). */
export const collectAsync = async <T>(iterator: AsyncIterator<T>): Promise<readonly T[]> =>
  Array.fromAsync({ [Symbol.asyncIterator]: () => iterator })

/** Linha do lote já classificada; o `index` permite cortar descartes além do `limit`. */
type ClassifiedLine<T> =
  | { readonly kind: 'blank'; readonly index: number }
  | { readonly kind: 'skipped'; readonly index: number }
  | { readonly kind: 'value'; readonly index: number; readonly value: T }

const isValueLine = <T>(
  entry: ClassifiedLine<T>,
): entry is Extract<ClassifiedLine<T>, { readonly kind: 'value' }> => entry.kind === 'value'

const classifyLine = <T>(
  line: string,
  index: number,
  parse: (line: string) => T | null,
): ClassifiedLine<T> => {
  if (line.trim().length === 0) return { kind: 'blank', index }
  const value = parse(line)
  return value === null ? { kind: 'skipped', index } : { kind: 'value', index, value }
}

/**
 * Classifica as linhas do lote com `map`/`filter`/`slice` (uma única passada por
 * linha, sem copiar o acumulador) e conta os descartes **até** o corte por
 * `limit`: descartes de linhas que ficariam de fora não entram em `skipped`.
 */
const scanLines = <T>(
  lines: readonly string[],
  options: LineIngestOptions<T>,
  budget: number | undefined,
): LineBatch<T> => {
  const classified = lines.map((line, index) => classifyLine(line, index, options.parse))
  const kept = classified.filter(isValueLine).slice(0, budget)
  const cutoff = budget === undefined ? Number.POSITIVE_INFINITY : (kept.at(-1)?.index ?? -1)
  const skipped = classified.filter((entry) => entry.kind === 'skipped' && entry.index <= cutoff).length
  return { values: kept.map((entry) => entry.value), skipped }
}

export const ingestLineStream = async <T>(
  iterator: AsyncIterator<string>,
  options: LineIngestOptions<T>,
): Promise<LineIngestStats> => {
  const step = async (stats: LineIngestStats): Promise<LineIngestStats> => {
    if (options.limit !== undefined && stats.ingested >= options.limit) return stats

    const lines = await takeAsync(iterator, options.batchSize)
    if (lines.length === 0) return stats

    const budget = options.limit === undefined ? undefined : options.limit - stats.ingested
    const batch = scanLines(lines, options, budget)
    if (batch.values.length > 0) await options.write(batch.values)

    return step({
      ingested: stats.ingested + batch.values.length,
      skipped: stats.skipped + batch.skipped,
    })
  }

  return step({ ingested: 0, skipped: 0 })
}
