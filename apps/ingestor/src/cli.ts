import { createDbPool, runMigrations } from '@comprova/db'
import { createHmac } from 'node:crypto'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTenant, seedGoldenDataset } from '@comprova/testing'

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

const command = process.argv[2] ?? 'help'

const fixtures = async (): Promise<void> => {
  await runMigrations({ adminUrl, rolePassword: process.env.APP_DB_PASSWORD })
  const pool = createDbPool(adminUrl, { max: 1 })
  try {
    await seedGoldenDataset(pool.db)
    await createTenant(pool.db, { name: 'dev-tenant' })
    console.log('golden dataset seeded (CNAE categorias, CEPs, CNEFE, estabelecimentos, perfis)')
  } finally {
    await pool.end()
  }
}

const ingestEstabelecimentos = async (file: string, limit?: number, snapshot?: string): Promise<void> => {
  const { ingestReceitaEstabelecimentos } = await import('./receita-estabelecimentos.js')
  await runMigrations({ adminUrl, rolePassword: process.env.APP_DB_PASSWORD })
  const pool = createDbPool(adminUrl, { max: 4 })
  try {
    const snapshotMonth = (snapshot ?? '2026-09') + '-01'
    const stats = await ingestReceitaEstabelecimentos(pool.db, file, snapshotMonth, {
      ...(limit !== undefined ? { limit } : {}),
    })
    const rate = stats.elapsedMs > 0 ? Math.round((stats.rows / stats.elapsedMs) * 1000) : 0
    console.log(
      `ingested ${stats.rows} rows in ${Math.round(stats.elapsedMs / 1000)}s (${rate} rows/s), snapshot ${stats.snapshotMonth}`,
    )
  } finally {
    await pool.end()
  }
}

const ingestMunicipios = async (file: string): Promise<void> => {
  const { ingestReceitaMunicipios } = await import('./receita-estabelecimentos.js')
  await runMigrations({ adminUrl, rolePassword: process.env.APP_DB_PASSWORD })
  const pool = createDbPool(adminUrl, { max: 1 })
  try {
    const count = await ingestReceitaMunicipios(pool.db, file, '2026-09')
    console.log(`ingested ${count} municipios`)
  } finally {
    await pool.end()
  }
}

switch (command) {
  case 'fixtures':
    await fixtures()
    break
  case 'policy:simulate': {
    const target = process.argv[3]
    if (!target) {
      throw new Error('usage: ingestor policy:simulate <versao-alvo> [--report]')
    }
    const { simulatePolicy } = await import('./policy-simulate.js')
    const pool = createDbPool(adminUrl, { max: 2 })
    try {
      const report = await simulatePolicy(pool.db, target)
      console.log(`politica alvo: ${report.targetPolicyVersion}`)
      console.log(`validacoes: ${report.total} | divergentes: ${report.divergent}`)
      for (const tr of report.transitions) {
        console.log(`  ${tr.from} -> ${tr.to}: ${tr.count}`)
      }
      for (const s of report.samples) {
        console.log(
          `  amostra ${s.validationId}: ${s.storedVerdict} (politica ${s.storedPolicyVersion}) -> ${s.simulatedVerdict}`,
        )
      }
      if (process.argv.includes('--report')) {
        const dir = 'docs/policy-reports'
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, `${target}.json`), JSON.stringify(report, null, 2))
        console.log(`relatorio salvo em docs/policy-reports/${target}.json`)
      }
    } finally {
      await pool.end()
    }
    break
  }
  case 'load-tenant': {
    const pool = createDbPool(adminUrl, { max: 1 })
    try {
      const tenantId = randomUUID()
      await pool.db.insert((await import('@comprova/db')).tenant).values({
        tenantId,
        name: 'load-tenant',
        rateLimitRps: 100_000,
        burst: 200_000,
      })
      const pepper = process.env.API_KEY_PEPPER ?? 'dev-pepper-change-me'
      const plaintext = `cvk_${randomBytes(24).toString('base64url')}`
      const keyHash = createHmac('sha256', pepper).update(plaintext).digest()
      await pool.db.insert((await import('@comprova/db')).apiKey).values({
        apiKeyId: randomUUID(),
        tenantId,
        keyPrefix: plaintext.slice(0, 12),
        keyHash: Buffer.from(keyHash),
      })
      console.log(plaintext)
    } finally {
      await pool.end()
    }
    break
  }
  case 'receita:estabelecimentos': {
    const file = process.argv[3]
    const limitFlag = process.argv.indexOf('--limit')
    const limit = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : undefined
    const snapFlag = process.argv.indexOf('--snapshot')
    const snapshot = snapFlag > 0 ? process.argv[snapFlag + 1] : undefined
    if (!file) {
      throw new Error('usage: ingestor receita:estabelecimentos <csv> [--limit N] [--snapshot 2026-09]')
    }
    await ingestEstabelecimentos(file, limit, snapshot)
    break
  }
  case 'profiles:recompute': {
    const { recomputeAddressProfiles, seedCanonicalAddresses } = await import('./address-profile.js')
    const pool = createDbPool(adminUrl, { max: 1 })
    try {
      const seeded = await seedCanonicalAddresses(pool.db)
      console.log(`canonical addresses seeded: ${seeded}`)
      const count = await recomputeAddressProfiles(pool.db)
      console.log(`address profiles recomputed for ${count} addresses`)
    } finally {
      await pool.end()
    }
    break
  }
  case 'ceps:backfill': {
    const { backfillCepsFromEstabelecimentos } = await import('./cep-backfill.js')
    const limitFlag = process.argv.indexOf('--limit')
    const limit = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : 500
    const pool = createDbPool(adminUrl, { max: 2 })
    try {
      const stats = await backfillCepsFromEstabelecimentos(pool.db, {
        ...(limit !== undefined ? { limit } : {}),
      })
      console.log(
        `ceps: ${stats.cepsProcessed} processed, ${stats.cepsFound} found, ${stats.cepsNotFound} not found (${Math.round(stats.elapsedMs / 1000)}s)`,
      )
    } finally {
      await pool.end()
    }
    break
  }
  case 'receita:ibge-derive': {
    const { deriveMunicipioIbge, deriveMunicipioUf } = await import('./cep-backfill.js')
    const pool = createDbPool(adminUrl, { max: 1 })
    try {
      const ibgeCount = await deriveMunicipioIbge(pool.db)
      console.log(`municipio_ibge derived for ${ibgeCount} estabelecimentos`)
      const ufCount = await deriveMunicipioUf(pool.db)
      console.log(`uf derived for ${ufCount} municipios`)
    } finally {
      await pool.end()
    }
    break
  }
  case 'receita:municipios': {
    const file = process.argv[3]
    if (!file) {
      throw new Error('usage: ingestor receita:municipios <csv>')
    }
    await ingestMunicipios(file)
    break
  }
  default:
    console.log(
      'comandos: fixtures | receita:estabelecimentos <csv> [--limit N] | policy:simulate <versao> [--report]',
    )
    console.log('gate adiada (Fase 1): ingestao completa do dump real + medicao de tempo')
}
