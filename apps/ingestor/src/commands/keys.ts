import type { CommandHandler } from './types.js'

/**
 * Estimativa do número de estabelecimentos do snapshot 2026-09, usada apenas
 * para o percentual de progresso (evita um `count(*)` de 30M linhas). Não afeta
 * o que é reprocessado.
 */
const SNAPSHOT_ROW_ESTIMATE = 30_585_232

/** Reprocessa `building_key`/`unit_key` de todos os estabelecimentos. */
export const keysRebuild: CommandHandler = async (context) => {
  const postgres = (await import('postgres')).default
  const { rebuildEstablishmentKeys } = await import('../modules/rebuild-keys/rebuild-keys.service.js')

  const client = postgres(context.config.adminUrl, { max: 2 })
  const started = Date.now()

  try {
    const total = await rebuildEstablishmentKeys(client, {
      onProgress: ({ processed, elapsedMs }) => {
        const rate = elapsedMs > 0 ? Math.round((processed / elapsedMs) * 1000) : 0
        const percent = Math.round((processed / SNAPSHOT_ROW_ESTIMATE) * 100)
        context.logger.info(`${processed}/${SNAPSHOT_ROW_ESTIMATE} (${rate}/s, ${percent}%)`)
      },
    })
    context.logger.info(`done: ${total} keys in ${Math.round((Date.now() - started) / 1000)}s`)
  } finally {
    await client.end()
  }
}
