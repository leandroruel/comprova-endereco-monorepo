import type { CommandHandler } from './types.js'

export const profilesRecompute: CommandHandler = async (context) => {
  const { seeded, count } = await context.withDb(1, async (db) => {
    const { recomputeAddressProfiles, seedCanonicalAddresses } =
      await import('../modules/address-profile/address-profile.service.js')
    return {
      seeded: await seedCanonicalAddresses(db),
      count: await recomputeAddressProfiles(db),
    }
  })
  context.logger.info(`canonical addresses seeded: ${seeded}`)
  context.logger.info(`address profiles recomputed for ${count} addresses`)
}
