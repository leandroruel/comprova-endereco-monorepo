import { runReferenceMigrations } from '../context.js'
import type { CommandHandler } from './types.js'

/** Roda as migrations e popula o dataset dourado + tenant de desenvolvimento. */
export const fixtures: CommandHandler = async (context) => {
  // Dataset dourado toca os DOIS domínios: estruturas/tabelas de referência
  // (CNAE, CEps, CNEFE, estabelecimentos) e operacionais (perfis, tenant).
  await context.runMigrations()
  await runReferenceMigrations(context)
  await context.withDb(1, async (appDb) => {
    await context.withRefDb(1, async (refDb) => {
      const { createTenant, seedGoldenDataset } = await import('@comprova/testing')
      await seedGoldenDataset(appDb, refDb)
      await createTenant(appDb, { name: 'dev-tenant' })
    })
  })
  context.logger.info('golden dataset seeded (CNAE categorias, CEPs, CNEFE, estabelecimentos, perfis)')
}
