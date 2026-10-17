import type { CachedSignal, CheckContext, Checker, DocKind, Signal, SignalCacheReader } from '@comprova/core'
import type { Stance } from '@comprova/core'

/** Linha de `signal` persistida (subconjunto usado no processamento do deep path). */
export interface PriorSignalRow {
  readonly signalId: string
  readonly checkerId: string
  readonly checkerVersion: string
  readonly stance: Stance
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: Date
  readonly ttlSeconds: number
  readonly detail: Record<string, unknown>
  readonly evidenceId: string | null
}

export const signalFromRow = (row: PriorSignalRow): Signal => ({
  checkerId: row.checkerId,
  checkerVersion: row.checkerVersion,
  stance: row.stance,
  strength: row.strength,
  confidence: row.confidence,
  source: row.source,
  observedAt: row.observedAt.toISOString(),
  ttlSeconds: row.ttlSeconds,
  detail: row.detail,
})

export const signalFromCached = (cached: CachedSignal): Signal => ({
  checkerId: cached.checkerId,
  checkerVersion: cached.checkerVersion,
  stance: cached.stance,
  strength: cached.strength,
  confidence: cached.confidence,
  source: cached.source,
  observedAt: cached.observedAt,
  ttlSeconds: cached.ttlSeconds,
  detail: cached.detail,
  ...(cached.evidenceId !== undefined ? { evidenceId: cached.evidenceId } : {}),
})

export interface RunCheckersInput {
  readonly checkers: readonly Checker[]
  readonly prior: readonly Signal[]
  readonly ctx: CheckContext
  readonly docType: DocKind
  readonly addressId: string | null
  readonly signalCache?: SignalCacheReader
}

/**
 * Executa checkers em sequência, encadeando os sinais produzidos (`priorSignals`)
 * e consultando o cache por endereço antes de rodar cada checker. Puro em relação
 * ao banco exceto pelas duas portas (`checker.run`, `signalCache.getCached`).
 */
export const runCheckersSequentially = async (input: RunCheckersInput): Promise<readonly Signal[]> =>
  input.checkers.reduce<Promise<readonly Signal[]>>(async (acc, checker) => {
    const list = await acc
    if (!checker.appliesTo.includes(input.docType)) return list

    const addressId = input.addressId
    const signalCache = input.signalCache
    if (addressId !== null && signalCache !== undefined) {
      const cached = await signalCache.getCached(addressId, checker.id)
      if (cached !== null) return [...list, signalFromCached(cached)]
    }

    const produced = await checker.run({ ...input.ctx, priorSignals: [...input.prior, ...list] })
    return [...list, ...produced]
  }, Promise.resolve([]))
