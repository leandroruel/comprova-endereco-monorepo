import { migrateReferenceData } from './migrate-reference-data.js'

/**
 * Copia os dados de referência do database operacional para o database de
 * referência ( estratégia segura: origem apenas lida, destino idempotente).
 *
 *   pnpm db:migrate-reference-data
 *
 * Envs:
 *   DATABASE_ADMIN_URL            → fonte (database operacional), somente leitura
 *   REFERENCE_DATABASE_ADMIN_URL  → destino (database de referência), requer INSERT
 */
const source = process.env.DATABASE_ADMIN_URL
const target = process.env.REFERENCE_DATABASE_ADMIN_URL

if (!source || !target) {
  console.error('DATABASE_ADMIN_URL and REFERENCE_DATABASE_ADMIN_URL are required')
  process.exit(1)
}

const result = await migrateReferenceData({
  sourceAdminUrl: source,
  targetAdminUrl: target,
  ...(process.argv.includes('--replace') ? { replace: true } : {}),
  onProgress: (message) => console.log(message),
})

for (const table of result.tables) {
  console.log(
    `${table.table}: source=${table.sourceRows} target=${table.targetRows}${
      table.skippedBecausePopulated ? ' (skipped, already populated)' : ''
    }`,
  )
}

if (!result.valid) {
  console.error(
    'row count mismatch between source and target — investigate before switching REFERENCE_DATABASE_URL',
  )
  process.exit(2)
}

console.log('reference data migration validated (row counts match)')
