import type { CepReader, CepRecord } from '@comprova/core'
import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { refCep } from '../schemas/reference-address.js'

export const makeCepReader = (db: Db): CepReader => ({
  get: async (cep: string): Promise<CepRecord | null> => {
    const rows = await db.select().from(refCep).where(eq(refCep.cep, cep)).limit(1)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          uf: row.uf,
          municipioIbge: row.municipioIbge,
          localidade: row.localidade,
          bairro: row.bairro,
          logradouroNorm: row.logradouroNorm,
        }
  },
})
