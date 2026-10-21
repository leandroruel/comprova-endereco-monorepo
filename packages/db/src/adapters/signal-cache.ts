import type { SignalCacheReader } from '@comprova/core'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { addressSignalCache } from '../schemas/claims.js'

export const makeSignalCacheReader = (db: Db): SignalCacheReader => ({
  getCached: async (addressId: string, checkerId: string) => {
    const rows = await db
      .select({
        checkerId: addressSignalCache.checkerId,
        checkerVersion: addressSignalCache.checkerVersion,
        stance: addressSignalCache.stance,
        strength: addressSignalCache.strength,
        confidence: addressSignalCache.confidence,
        source: addressSignalCache.source,
        observedAt: addressSignalCache.observedAt,
        expiresAt: addressSignalCache.expiresAt,
        detail: addressSignalCache.detail,
        evidenceId: addressSignalCache.evidenceId,
      })
      .from(addressSignalCache)
      .where(
        and(
          eq(addressSignalCache.addressId, addressId),
          eq(addressSignalCache.checkerId, checkerId),
          sql`${addressSignalCache.expiresAt} > now()`,
        ),
      )
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    return {
      checkerId: row.checkerId,
      checkerVersion: row.checkerVersion,
      stance: row.stance,
      strength: row.strength,
      confidence: row.confidence,
      source: row.source,
      observedAt: row.observedAt.toISOString(),
      ttlSeconds: Math.max(1, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)),
      detail: row.detail,
      ...(row.evidenceId !== null ? { evidenceId: row.evidenceId } : {}),
    }
  },
})
