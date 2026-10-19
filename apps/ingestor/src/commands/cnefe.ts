import { flagNumber } from '../cli-args.js'
import type { CommandHandler } from './types.js'

export const cnefeUf: CommandHandler = async (context, args) => {
  const file = args[0]
  if (file === undefined) throw new Error('usage: ingestor cnefe:uf <csv> [--limit N]')
  const limit = flagNumber(args, '--limit')

  const stats = await context.withDb(4, async (db) => {
    const { ingestCnefeCsv } = await import('../modules/cnefe/cnefe.service.js')
    return ingestCnefeCsv(db, file, { ...(limit !== undefined ? { limit } : {}) })
  })

  const rate = stats.elapsedMs > 0 ? Math.round((stats.rows / stats.elapsedMs) * 1000) : 0
  context.logger.info(
    `cnefe: ${stats.rows} rows, ${stats.skipped} skipped in ${Math.round(stats.elapsedMs / 1000)}s (${rate} rows/s)`,
  )
}
