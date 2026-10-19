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

/** Lê até `n` linhas do iterador (recursivo; devolve um novo array a cada passo). */
export const takeAsync = async <T>(iterator: AsyncIterator<T>, n: number): Promise<readonly T[]> => {
  const read = async (acc: readonly T[]): Promise<readonly T[]> => {
    if (acc.length >= n) return acc
    const next = await iterator.next()
    return next.done === true ? acc : read([...acc, next.value])
  }
  return read([])
}

/** Drena o iterador inteiro para um array. Para fontes pequenas (ex.: municípios). */
export const collectAsync = async <T>(iterator: AsyncIterator<T>): Promise<readonly T[]> => {
  const read = async (acc: readonly T[]): Promise<readonly T[]> => {
    const next = await iterator.next()
    return next.done === true ? acc : read([...acc, next.value])
  }
  return read([])
}

/**
 * Classifica as linhas de um lote até esgotá-las ou atingir `budget` linhas
 * válidas — a partir daí para de consumir o lote, para que o corte por `limit`
 * não conte descartes de linhas que ficariam de fora.
 */
const scanLines = <T>(
  lines: readonly string[],
  options: LineIngestOptions<T>,
  budget: number | undefined,
  index: number,
  acc: LineBatch<T>,
): LineBatch<T> => {
  const line = lines[index]
  if (line === undefined) return acc
  if (budget !== undefined && acc.values.length >= budget) return acc
  if (line.trim().length === 0) return scanLines(lines, options, budget, index + 1, acc)

  const value = options.parse(line)
  return value === null
    ? scanLines(lines, options, budget, index + 1, { ...acc, skipped: acc.skipped + 1 })
    : scanLines(lines, options, budget, index + 1, { ...acc, values: [...acc.values, value] })
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
    const batch = scanLines(lines, options, budget, 0, { values: [], skipped: 0 })
    if (batch.values.length > 0) await options.write(batch.values)

    return step({
      ingested: stats.ingested + batch.values.length,
      skipped: stats.skipped + batch.skipped,
    })
  }

  return step({ ingested: 0, skipped: 0 })
}
