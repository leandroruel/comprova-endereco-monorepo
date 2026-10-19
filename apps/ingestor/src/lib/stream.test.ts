import { describe, expect, it } from 'vitest'
import { ingestLineStream } from './stream.js'

/** `x` = linha descartada; vazia = ignorada; número = linha válida. */
const parse = (line: string): number | null => {
  const trimmed = line.trim()
  if (trimmed === 'x') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

const scene = (lines: readonly string[]) => {
  const writes: number[][] = []
  const iterator = (async function* generate() {
    for (const line of lines) yield line
  })()
  return { writes, iterator }
}

describe('ingestLineStream', () => {
  it('grava em lotes de `batchSize` e soma os ingeridos', async () => {
    const { writes, iterator } = scene(['1', '2', '3', '4', '5'])

    const stats = await ingestLineStream(iterator, {
      batchSize: 2,
      parse,
      write: async (b) => void writes.push([...b]),
    })

    expect(writes).toEqual([[1, 2], [3, 4], [5]])
    expect(stats).toEqual({ ingested: 5, skipped: 0 })
  })

  it('conta descartes e ignora linhas em branco', async () => {
    const { writes, iterator } = scene(['1', 'x', '', '2', '  '])

    const stats = await ingestLineStream(iterator, {
      batchSize: 10,
      parse,
      write: async (b) => void writes.push([...b]),
    })

    expect(writes).toEqual([[1, 2]])
    expect(stats).toEqual({ ingested: 2, skipped: 1 })
  })

  it('para depois de `limit` linhas válidas', async () => {
    const { writes, iterator } = scene(['1', '2', '3'])

    const stats = await ingestLineStream(iterator, {
      batchSize: 10,
      limit: 2,
      parse,
      write: async (b) => void writes.push([...b]),
    })

    expect(writes).toEqual([[1, 2]])
    expect(stats).toEqual({ ingested: 2, skipped: 0 })
  })

  it('não conta descartes que ficariam além do `limit` no mesmo lote', async () => {
    const { writes, iterator } = scene(['1', '2', 'x', '3'])

    const stats = await ingestLineStream(iterator, {
      batchSize: 10,
      limit: 2,
      parse,
      write: async (b) => void writes.push([...b]),
    })

    expect(writes).toEqual([[1, 2]])
    expect(stats).toEqual({ ingested: 2, skipped: 0 })
  })

  it('não grava lote quando nada é aproveitado', async () => {
    const { writes, iterator } = scene(['x', '', 'x'])

    const stats = await ingestLineStream(iterator, {
      batchSize: 10,
      parse,
      write: async (b) => void writes.push([...b]),
    })

    expect(writes).toEqual([])
    expect(stats).toEqual({ ingested: 0, skipped: 2 })
  })
})
