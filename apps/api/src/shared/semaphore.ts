/**
 * Semáforo de contagem com fila FIFO. Usado para limitar quantos uploads de
 * comprovante podem estar em voo por processo: cada um pode bufferizar até
 * `EVIDENCE_MAX_BYTES` antes de ir para o storage.
 *
 * O `acquire` devolve um `release` idempotente; o chamador deve liberar em
 * `finally` para cobrir sucesso, erro e replay.
 */
export interface Semaphore {
  readonly acquire: () => Promise<() => void>
  readonly inFlight: number
  readonly waiting: number
}

const once = (fn: () => void): (() => void) => {
  let called = false
  return () => {
    if (called) return
    called = true
    fn()
  }
}

export const makeSemaphore = (limit: number): Semaphore => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('semaphore limit must be a positive integer')
  }

  let available = limit
  const waiters: Array<() => void> = []

  const releasePermit = (): void => {
    const next = waiters.shift()
    if (next !== undefined) {
      // Transfere o slot direto para o próximo waiter; `available` continua 0.
      next()
      return
    }
    available += 1
  }

  return {
    acquire: async () => {
      if (available > 0) {
        available -= 1
      } else {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      return once(releasePermit)
    },
    get inFlight() {
      return limit - available
    },
    get waiting() {
      return waiters.length
    },
  }
}
