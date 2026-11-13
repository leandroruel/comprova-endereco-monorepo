import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLoop } from './loops.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('startLoop', () => {
  it('executa ticks no intervalo e para de agendar depois do stop', async () => {
    vi.useFakeTimers()
    let ticks = 0
    const stop = startLoop(async () => {
      ticks += 1
    }, 1_000)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(ticks).toBe(3)

    await stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ticks).toBe(3)
  })

  it('o stop aguarda o tick em andamento terminar', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let ticks = 0
    let finishedStop = false
    const stop = startLoop(async () => {
      ticks += 1
      await gate
    }, 1_000)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(ticks).toBe(1)

    const stopping = stop().then(() => {
      finishedStop = true
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ticks).toBe(1)
    expect(finishedStop).toBe(false)

    release()
    await stopping
    expect(finishedStop).toBe(true)
  })

  it('não inicia um tick novo enquanto o anterior está em andamento', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let ticks = 0
    const stop = startLoop(async () => {
      ticks += 1
      await gate
    }, 1_000)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(ticks).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ticks).toBe(2)

    await stop()
  })
})
