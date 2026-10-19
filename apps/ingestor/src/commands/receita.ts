import { flagNumber, flagValue, parseSnapshotMonth } from '../cli-args.js'
import type { CommandHandler } from './types.js'

export const receitaEstabelecimentos: CommandHandler = async (context, args) => {
  const file = args[0]
  if (file === undefined) {
    throw new Error('usage: ingestor receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N]')
  }
  const snapshotMonth = parseSnapshotMonth(flagValue(args, '--snapshot'))
  const limit = flagNumber(args, '--limit')

  await context.runMigrations()
  const stats = await context.withDb(4, async (db) => {
    const { ingestReceitaEstabelecimentos } = await import('../modules/receita/receita.service.js')
    return ingestReceitaEstabelecimentos(db, file, snapshotMonth, {
      ...(limit !== undefined ? { limit } : {}),
    })
  })

  const rate = stats.elapsedMs > 0 ? Math.round((stats.rows / stats.elapsedMs) * 1000) : 0
  context.logger.info(
    `ingested ${stats.rows} rows in ${Math.round(stats.elapsedMs / 1000)}s (${rate} rows/s), snapshot ${stats.snapshotMonth}`,
  )
}

export const receitaMunicipios: CommandHandler = async (context, args) => {
  const file = args[0]
  if (file === undefined) throw new Error('usage: ingestor receita:municipios <csv>')

  await context.runMigrations()
  const count = await context.withDb(1, async (db) => {
    const { ingestReceitaMunicipios } = await import('../modules/receita/receita.service.js')
    return ingestReceitaMunicipios(db, file)
  })
  context.logger.info(`ingested ${count} municipios`)
}

export const receitaIbgeDerive: CommandHandler = async (context) => {
  const { ibgeCount, ufCount } = await context.withDb(1, async (db) => {
    const { deriveMunicipioIbge, deriveMunicipioUf } = await import('../modules/cep/cep.service.js')
    return {
      ibgeCount: await deriveMunicipioIbge(db),
      ufCount: await deriveMunicipioUf(db),
    }
  })
  context.logger.info(`municipio_ibge derived for ${ibgeCount} estabelecimentos`)
  context.logger.info(`uf derived for ${ufCount} municipios`)
}
