import { describe, expect, it } from 'vitest'
import { makeSemaphore } from '../../src/shared/semaphore.js'

describe('makeSemaphore', () => {
  it('limita a concorrência e entrega slots em FIFO', async () => {
    const semaphore = makeSemaphore(2)
    const releaseFirst = await semaphore.acquire()
    const releaseSecond = await semaphore.acquire()
    expect(semaphore.inFlight).toBe(2)

    const order: string[] = []
    const thirdPromise = semaphore.acquire().then((release) => {
      order.push('third')
      return release
    })
    const fourthPromise = semaphore.acquire().then((release) => {
      order.push('fourth')
      return release
    })
    expect(semaphore.waiting).toBe(2)
    expect(order).toEqual([])

    releaseFirst()
    const releaseThird = await thirdPromise
    expect(order).toEqual(['third'])
    expect(semaphore.inFlight).toBe(2)

    releaseSecond()
    const releaseFourth = await fourthPromise
    expect(order).toEqual(['third', 'fourth'])

    releaseThird()
    releaseFourth()
    expect(semaphore.inFlight).toBe(0)
    expect(semaphore.waiting).toBe(0)
  })

  it('ignora release duplicado', async () => {
    const semaphore = makeSemaphore(1)
    const release = await semaphore.acquire()
    release()
    release()
    expect(semaphore.inFlight).toBe(0)

    const next = await semaphore.acquire()
    expect(semaphore.inFlight).toBe(1)
    next()
    expect(semaphore.inFlight).toBe(0)
  })

  it('recusa limite inválido', () => {
    expect(() => makeSemaphore(0)).toThrow(/positive integer/)
    expect(() => makeSemaphore(-1)).toThrow(/positive integer/)
    expect(() => makeSemaphore(1.5)).toThrow(/positive integer/)
  })
})
