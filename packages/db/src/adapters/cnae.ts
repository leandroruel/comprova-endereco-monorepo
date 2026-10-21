import type { CnaeCategoria } from '@comprova/core'
import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { refCnaeDivisaoCategoria } from '../schemas/reference-receita.js'

export const makeCnaeCategoriaReader = (db: Db) => ({
  categoriaForDivisao: async (divisao: string): Promise<CnaeCategoria> => {
    const rows = await db
      .select({ categoria: refCnaeDivisaoCategoria.categoria })
      .from(refCnaeDivisaoCategoria)
      .where(eq(refCnaeDivisaoCategoria.divisao, divisao))
      .limit(1)
    const row = rows[0]
    return (row?.categoria as CnaeCategoria | undefined) ?? 'MIXED'
  },
})
