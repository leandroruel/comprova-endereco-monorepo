import { describe, expect, it, vi } from 'vitest'
import type { DbPool } from '@comprova/db'
import type { Logger } from '@comprova/observability'
import { closePools } from './index.js'

const makePool = (shouldFail = false): DbPool =>
  ({
    end: async () => {
      if (shouldFail) throw new Error('pool end failed')
    },
  }) as unknown as DbPool

class FakeLogger implements Logger {
  errorCalls: Array<{ arg?: string | Record<string, unknown>; msg?: string }> = []
  debug(_arg: string | Record<string, unknown>, _msg?: string): void {
    // noop
  }
  info(_arg: string | Record<string, unknown>, _msg?: string): void {
    // noop
  }
  warn(_arg: string | Record<string, unknown>, _msg?: string): void {
    // noop
  }
  error(arg: string | Record<string, unknown>, msg?: string): void {
    this.errorCalls.push({ arg, msg })
  }
  child(_bindings: Record<string, unknown>): Logger {
    return this
  }
}

describe('closePools', () => {
  it('chama end() em todos os pools quando todos funcionam', async () => {
    const logger = new FakeLogger()
    const p1 = makePool()
    const p2 = makePool()
    const p3 = makePool()
    vi.spyOn(p1, 'end')
    vi.spyOn(p2, 'end')
    vi.spyOn(p3, 'end')

    await closePools([p1, p2, p3], logger)

    expect(p1.end).toHaveBeenCalledTimes(1)
    expect(p2.end).toHaveBeenCalledTimes(1)
    expect(p3.end).toHaveBeenCalledTimes(1)
    expect(logger.errorCalls).toHaveLength(0)
  })

  it('chama end() nos outros pools mesmo quando um falha', async () => {
    const logger = new FakeLogger()
    const p1 = makePool()
    const p2 = makePool(true)
    const p3 = makePool()
    vi.spyOn(p1, 'end')
    vi.spyOn(p2, 'end')
    vi.spyOn(p3, 'end')

    await expect(closePools([p1, p2, p3], logger)).rejects.toThrow()

    expect(p1.end).toHaveBeenCalledTimes(1)
    expect(p2.end).toHaveBeenCalledTimes(1)
    expect(p3.end).toHaveBeenCalledTimes(1)
  })

  it('registra e propaga a falha sem silenciar', async () => {
    const logger = new FakeLogger()
    const p1 = makePool(true)
    const p2 = makePool(true)

    await expect(closePools([p1, p2], logger)).rejects.toThrow('failed to close 2 pool(s)')

    expect(logger.errorCalls.length).toBeGreaterThan(0)
    expect(logger.errorCalls[0]?.msg).toBe('worker pool close failures')
  })

  it('não lança quando não há pools', async () => {
    const logger = new FakeLogger()
    await expect(closePools([], logger)).resolves.toBeUndefined()
    expect(logger.errorCalls).toHaveLength(0)
  })
})
