import type { CommandHandler } from './types.js'

/** Roda as migrations e popula o dataset dourado + tenant de desenvolvimento. */
export const fixtures: CommandHandler = async (context) => {
  await context.runMigrations()
  await context.withDb(1, async (db) => {
    const { createTenant, seedGoldenDataset } = await import('@comprova/testing')
    await seedGoldenDataset(db)
    await createTenant(db, { name: 'dev-tenant' })
  })
  context.logger.info('golden dataset seeded (CNAE categorias, CEPs, CNEFE, estabelecimentos, perfis)')
}
