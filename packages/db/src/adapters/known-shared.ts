import type { KnownSharedReader } from '@comprova/core'
import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { refKnownSharedAddress } from '../schemas/reference-address.js'

export const makeKnownSharedReader = (db: Db): KnownSharedReader => ({
  get: async (buildingKey: Uint8Array) => {
    const rows = await db
      .select({ kind: refKnownSharedAddress.kind })
      .from(refKnownSharedAddress)
      .where(eq(refKnownSharedAddress.buildingKey, Buffer.from(buildingKey)))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : { kind: row.kind }
  },
})
