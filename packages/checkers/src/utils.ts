import type { Signal, Stance } from '@comprova/core'

export interface SignalInput {
  readonly checkerId: string
  readonly checkerVersion: string
  readonly stance: Stance
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: string
  readonly ttlSeconds: number
  readonly detail: Record<string, unknown>
  readonly evidenceId?: string
}

export const makeSignal = (input: SignalInput): Signal => ({
  checkerId: input.checkerId,
  checkerVersion: input.checkerVersion,
  stance: input.stance,
  strength: input.strength,
  confidence: input.confidence,
  source: input.source,
  observedAt: input.observedAt,
  ttlSeconds: input.ttlSeconds,
  detail: input.detail,
  ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
})

export const detailHint = (signal: Signal): string | null => {
  const hint = signal.detail['verdict_hint']
  return typeof hint === 'string' ? hint : null
}

export const findSignalByChecker = (signals: readonly Signal[], checkerId: string): Signal | null =>
  signals.find((s) => s.checkerId === checkerId && s.stance !== 'unknown') ?? null
