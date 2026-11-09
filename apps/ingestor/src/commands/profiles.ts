import type { CommandHandler } from './types.js'

export const profilesRecompute: CommandHandler = async (context) => {
  // Dois domínios: agregados lidos das tabelas de referência
  // (`ref_receita_estabelecimento`) e gravação de perfis e endereços
  // canônicos no database operacional. Rodam em conexões separadas.
  const { seeded, count } = await context.withDb(1, async (appDb) => {
    return context.withRefDb(1, async (refDb) => {
      const { recomputeAddressProfiles, seedCanonicalAddresses } =
        await import('../modules/address-profile/address-profile.service.js')
      return {
        seeded: await seedCanonicalAddresses(appDb, refDb),
        count: await recomputeAddressProfiles(appDb, refDb),
      }
    })
  })
  context.logger.info(`canonical addresses seeded: ${seeded}`)
  context.logger.info(`address profiles recomputed for ${count} addresses`)
}
