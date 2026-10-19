import { flagNumber } from '../cli-args.js'
import type { CommandHandler } from './types.js'

export const cepsBackfill: CommandHandler = async (context, args) => {
  const limit = flagNumber(args, '--limit') ?? 500

  const stats = await context.withDb(2, async (db) => {
    const { backfillCepsFromEstabelecimentos } = await import('../modules/cep/cep.service.js')
    return backfillCepsFromEstabelecimentos(db, { limit })
  })

  context.logger.info(
    `ceps: ${stats.cepsProcessed} processed, ${stats.cepsFound} found, ${stats.cepsNotFound} not found (${Math.round(stats.elapsedMs / 1000)}s)`,
  )
}
