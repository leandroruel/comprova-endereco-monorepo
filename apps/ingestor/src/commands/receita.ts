import { flagNumber, flagValue, parseSnapshotMonth } from '../cli-args.js'
import { runReferenceMigrations } from '../context.js'
import type { CommandHandler } from './types.js'

export const receitaEstabelecimentos: CommandHandler = async (context, args) => {
  const file = args[0]
  if (file === undefined) {
    throw new Error('usage: ingestor receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N]')
  }
  const snapshotMonth = parseSnapshotMonth(flagValue(args, '--snapshot'))
  const limit = flagNumber(args, '--limit')

  // Domínio de referência: estrutura e dados vão no database de referência.
  await runReferenceMigrations(context)
  const stats = await context.withRefDb(4, async (db) => {
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

  await runReferenceMigrations(context)
  const count = await context.withRefDb(1, async (db) => {
    const { ingestReceitaMunicipios } = await import('../modules/receita/receita.service.js')
    return ingestReceitaMunicipios(db, file)
  })
  context.logger.info(`ingested ${count} municipios`)
}

export const receitaIbgeDerive: CommandHandler = async (context) => {
  // Derivacões acontecem inteiramente dentro das tabelas ref_*
  // (`ref_receita_estabelecimento`, `ref_receita_municipio`).
  const { ibgeCount, ufCount } = await context.withRefDb(1, async (db) => {
    const { deriveMunicipioIbge, deriveMunicipioUf } = await import('../modules/cep/cep.service.js')
    return {
      ibgeCount: await deriveMunicipioIbge(db),
      ufCount: await deriveMunicipioUf(db),
    }
  })
  context.logger.info(`municipio_ibge derived for ${ibgeCount} estabelecimentos`)
  context.logger.info(`uf derived for ${ufCount} municipios`)
}
