import { createLogger } from '@comprova/observability'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorkerLifecycle, type WorkerSignal, type WorkerSignalSource } from './lifecycle.js'
import { startLoop } from './loops.js'

const logger = createLogger({ level: 'silent' })

class FakeSignalSource implements WorkerSignalSource {
  private readonly listeners = new Map<WorkerSignal, Set<() => void>>()

  on(signal: WorkerSignal, listener: () => void): void {
    const current = this.listeners.get(signal) ?? new Set<() => void>()
    current.add(listener)
    this.listeners.set(signal, current)
  }

  emit(signal: WorkerSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener()
  }

  count(signal: WorkerSignal): number {
    return this.listeners.get(signal)?.size ?? 0
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runWorkerLifecycle', () => {
  it('inicia os loops uma única vez e permanece ativo até o sinal', async () => {
    vi.useFakeTimers()
    const signals = new FakeSignalSource()
    let startCalls = 0
    let ticks = 0
    const closed: string[] = []

    const running = runWorkerLifecycle({
      logger,
      signals,
      close: async () => {
        closed.push('close')
      },
      start: (track) => {
        startCalls += 1
        track(
          startLoop(async () => {
            ticks += 1
          }, 1_000),
        )
      },
    })

    await vi.advanceTimersByTimeAsync(2_500)
    expect(startCalls).toBe(1)
    expect(ticks).toBe(2)
    expect(closed).toEqual([])
    expect(signals.count('SIGTERM')).toBe(1)
    expect(signals.count('SIGINT')).toBe(1)

    signals.emit('SIGTERM')
    await expect(running).resolves.toBe('shutdown')
    expect(closed).toEqual(['close'])
  })

  it('SIGTERM impede novos ticks e aguarda o tick em andamento antes de fechar', async () => {
    vi.useFakeTimers()
    const signals = new FakeSignalSource()
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let ticks = 0

    const running = runWorkerLifecycle({
      logger,
      signals,
      close: async () => {
        order.push('close')
      },
      start: (track) => {
        track(
          startLoop(async () => {
            ticks += 1
            order.push('tick-start')
            await gate
            order.push('tick-end')
          }, 1_000),
        )
      },
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(ticks).toBe(1)

    signals.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(ticks).toBe(1)
    expect(order).toEqual(['tick-start'])

    release()
    await expect(running).resolves.toBe('shutdown')
    expect(order).toEqual(['tick-start', 'tick-end', 'close'])
  })

  it('SIGINT também encerra e um segundo sinal não duplica o shutdown', async () => {
    const signals = new FakeSignalSource()
    let stops = 0
    let closes = 0

    const running = runWorkerLifecycle({
      logger,
      signals,
      close: async () => {
        closes += 1
      },
      start: (track) => {
        track(async () => {
          stops += 1
        })
      },
    })

    signals.emit('SIGINT')
    signals.emit('SIGTERM')
    signals.emit('SIGINT')

    await expect(running).resolves.toBe('shutdown')
    expect(stops).toBe(1)
    expect(closes).toBe(1)
  })

  it('falha no boot limpa os recursos já iniciados e retorna boot_failure', async () => {
    const signals = new FakeSignalSource()
    const order: string[] = []

    const result = await runWorkerLifecycle({
      logger,
      signals,
      close: async () => {
        order.push('close')
      },
      start: (track) => {
        track(async () => {
          order.push('stop-1')
        })
        throw new Error('policy file missing')
      },
    })

    expect(result).toBe('boot_failure')
    expect(order).toEqual(['stop-1', 'close'])
  })
})
