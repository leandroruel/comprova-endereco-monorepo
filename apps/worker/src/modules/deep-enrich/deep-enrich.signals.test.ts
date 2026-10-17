import type { CachedSignal, CheckContext, Checker, Signal, SignalCacheReader } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import {
  runCheckersSequentially,
  signalFromCached,
  signalFromRow,
  type PriorSignalRow,
} from './deep-enrich.signals.js'

const signal = (checkerId: string, stance: Signal['stance'], strength: number): Signal => ({
  checkerId,
  checkerVersion: '1.0.0',
  stance,
  strength,
  confidence: 0.8,
  source: 'test',
  observedAt: '2026-01-01T00:00:00.000Z',
  ttlSeconds: 3600,
  detail: {},
})

const ctx: CheckContext = {
  subject: { docType: 'CNPJ', docDigitsValid: true, pseudonymized: true },
  address: null,
  priorSignals: [],
  clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
  metrics: { increment: () => undefined, observe: () => undefined },
}

const fakeChecker = (overrides: Partial<Checker> & Pick<Checker, 'id'>): Checker => ({
  version: '1.0.0',
  tier: 1,
  appliesTo: ['CNPJ', 'CPF'],
  timeoutMs: 1000,
  run: async () => [],
  ...overrides,
})

const cacheReader = (cached: CachedSignal | null): SignalCacheReader => ({
  getCached: async () => cached,
})

describe('signalFromRow / signalFromCached', () => {
  it('converte observedAt Date para ISO', () => {
    const row: PriorSignalRow = {
      signalId: 's1',
      checkerId: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'registry',
      observedAt: new Date('2026-02-03T04:05:06.000Z'),
      ttlSeconds: 60,
      detail: { k: 'v' },
      evidenceId: null,
    }
    expect(signalFromRow(row)).toEqual({
      checkerId: 'document_integrity',
      checkerVersion: '1.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 1,
      source: 'registry',
      observedAt: '2026-02-03T04:05:06.000Z',
      ttlSeconds: 60,
      detail: { k: 'v' },
    })
  })

  it('propaga evidenceId apenas quando presente', () => {
    const base: CachedSignal = {
      checkerId: 'c',
      checkerVersion: '1.0.0',
      stance: 'unknown',
      strength: 0.1,
      confidence: 0.2,
      source: 'cache',
      observedAt: '2026-01-01T00:00:00.000Z',
      ttlSeconds: 10,
      detail: {},
    }
    expect('evidenceId' in signalFromCached(base)).toBe(false)
    expect(signalFromCached({ ...base, evidenceId: 'ev-1' }).evidenceId).toBe('ev-1')
  })
})

describe('runCheckersSequentially', () => {
  it('encadeia os sinais produzidos como priorSignals do próximo checker', async () => {
    const seen: Signal[][] = []
    const first = signal('c1', 'supports', 0.8)
    const second = signal('c2', 'contradicts', 0.9)
    const checkers = [
      fakeChecker({
        id: 'c1',
        run: async (c) => {
          seen.push([...c.priorSignals])
          return [first]
        },
      }),
      fakeChecker({
        id: 'c2',
        run: async (c) => {
          seen.push([...c.priorSignals])
          return [second]
        },
      }),
    ]
    const prior = [signal('p0', 'neutral', 0.1)]

    const produced = await runCheckersSequentially({
      checkers,
      prior,
      ctx,
      docType: 'CNPJ',
      addressId: null,
    })

    expect(produced).toEqual([first, second])
    expect(seen[0]).toEqual(prior)
    expect(seen[1]).toEqual([...prior, first])
  })

  it('pula checkers que não se aplicam ao docType', async () => {
    const calls: string[] = []
    const checkers = [
      fakeChecker({
        id: 'only-cpf',
        appliesTo: ['CPF'],
        run: async () => {
          calls.push('only-cpf')
          return []
        },
      }),
      fakeChecker({
        id: 'both',
        run: async () => {
          calls.push('both')
          return []
        },
      }),
    ]

    const produced = await runCheckersSequentially({
      checkers,
      prior: [],
      ctx,
      docType: 'CNPJ',
      addressId: null,
    })

    expect(calls).toEqual(['both'])
    expect(produced).toEqual([])
  })

  it('usa o cache por endereço e não executa o checker', async () => {
    const runs: string[] = []
    const cached: CachedSignal = {
      checkerId: 'c1',
      checkerVersion: '2.0.0',
      stance: 'supports',
      strength: 0.5,
      confidence: 0.7,
      source: 'cache',
      observedAt: '2025-12-01T00:00:00.000Z',
      ttlSeconds: 100,
      detail: { cached: true },
      evidenceId: 'ev-1',
    }
    const checkers = [
      fakeChecker({
        id: 'c1',
        run: async () => {
          runs.push('c1')
          return []
        },
      }),
    ]

    const produced = await runCheckersSequentially({
      checkers,
      prior: [],
      ctx,
      docType: 'CNPJ',
      addressId: 'addr-1',
      signalCache: cacheReader(cached),
    })

    expect(runs).toEqual([])
    expect(produced).toEqual([{ ...cached }])
  })

  it('não consulta o cache quando não há addressId', async () => {
    const runs: string[] = []
    const checkers = [
      fakeChecker({
        id: 'c1',
        run: async () => {
          runs.push('c1')
          return [signal('c1', 'supports', 0.5)]
        },
      }),
    ]

    await runCheckersSequentially({
      checkers,
      prior: [],
      ctx,
      docType: 'CNPJ',
      addressId: null,
      signalCache: cacheReader({ ...signal('c1', 'supports', 0.5), ttlSeconds: 1 }),
    })

    expect(runs).toEqual(['c1'])
  })
})
