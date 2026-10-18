import { createDbPool, runMigrations } from '@comprova/db'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createCLILogger } from '@comprova/observability'
import { parseSnapshotMonth } from './cli-args.js'

const cli = createCLILogger('ingestor', process.env.LOG_LEVEL ?? 'info')
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
    cli.info('golden dataset seeded (CNAE categorias, CEPs, CNEFE, estabelecimentos, perfis)')
  } finally {
    await pool.end()
  }
}

const ingestEstabelecimentos = async (file: string, snapshotMonth: string, limit?: number): Promise<void> => {
  const { ingestReceitaEstabelecimentos } = await import('./receita-estabelecimentos.js')
  await runMigrations({ adminUrl, rolePassword: process.env.APP_DB_PASSWORD })
  const pool = createDbPool(adminUrl, { max: 4 })
  try {
    const stats = await ingestReceitaEstabelecimentos(pool.db, file, snapshotMonth, {
      ...(limit !== undefined ? { limit } : {}),
    })
    const rate = stats.elapsedMs > 0 ? Math.round((stats.rows / stats.elapsedMs) * 1000) : 0
    cli.info(
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
    const count = await ingestReceitaMunicipios(pool.db, file)
    cli.info(`ingested ${count} municipios`)
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
      cli.info(`politica alvo: ${report.targetPolicyVersion}`)
      cli.info(`validacoes: ${report.total} | divergentes: ${report.divergent}`)
      for (const tr of report.transitions) {
        cli.info(`  ${tr.from} -> ${tr.to}: ${tr.count}`)
      }
      for (const s of report.samples) {
        cli.info(
          `  amostra ${s.validationId}: ${s.storedVerdict} (politica ${s.storedPolicyVersion}) -> ${s.simulatedVerdict}`,
        )
      }
      if (process.argv.includes('--report')) {
        const dir = 'docs/policy-reports'
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, `${target}.json`), JSON.stringify(report, null, 2))
        cli.info(`relatorio salvo em docs/policy-reports/${target}.json`)
      }
    } finally {
      await pool.end()
    }
    break
  }
  case 'cache:flush': {
    const target = process.argv[3] ?? 'all'
    const Redis = (await import('ioredis')).default
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
    const { makeRedisCache, cacheKeys } = await import('@comprova/db')
    const cache = makeRedisCache(redis)
    try {
      if (target === 'all') {
        await cacheKeys.invalidateAll(cache)
        cli.info('cache: all keys invalidated')
      } else if (target === 'registry') {
        await cacheKeys.invalidateRegistry(cache)
        cli.info('cache: registry invalidated')
      } else if (target === 'cep') {
        await cacheKeys.invalidateCep(cache)
        cli.info('cache: cep invalidated')
      } else if (target === 'cnefe') {
        await cacheKeys.invalidateCnefe(cache)
        cli.info('cache: cnefe invalidated')
      } else if (target === 'profiles') {
        await cacheKeys.invalidateProfiles(cache)
        cli.info('cache: profiles invalidated')
      } else {
        cli.info('usage: ingestor cache:flush [all|registry|cep|cnefe|profiles]')
      }
      cli.info('cache stats:', JSON.stringify(cache.stats()))
    } finally {
      redis.disconnect()
    }
    break
  }
  case 'load-tenant': {
    const pool = createDbPool(adminUrl, { max: 1 })
    try {
      const { apiKey, makeApiKeyHasher, newApiKey, keyPrefixOf, tenant } = await import('@comprova/db')
      const tenantId = randomUUID()
      await pool.db.insert(tenant).values({
        tenantId,
        name: 'load-tenant',
        rateLimitRps: 100_000,
        burst: 200_000,
      })
      const pepper = process.env.API_KEY_PEPPER ?? 'dev-pepper-change-me'
      const plaintext = newApiKey()
      await pool.db.insert(apiKey).values({
        apiKeyId: randomUUID(),
        tenantId,
        keyPrefix: keyPrefixOf(plaintext),
        keyHash: makeApiKeyHasher(pepper).hash(plaintext),
      })
      cli.info(plaintext)
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
      throw new Error('usage: ingestor receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N]')
    }
    await ingestEstabelecimentos(file, parseSnapshotMonth(snapshot), limit)
    break
  }
  case 'profiles:recompute': {
    const { recomputeAddressProfiles, seedCanonicalAddresses } = await import('./address-profile.js')
    const pool = createDbPool(adminUrl, { max: 1 })
    try {
      const seeded = await seedCanonicalAddresses(pool.db)
      cli.info(`canonical addresses seeded: ${seeded}`)
      const count = await recomputeAddressProfiles(pool.db)
      cli.info(`address profiles recomputed for ${count} addresses`)
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
      cli.info(
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
      cli.info(`municipio_ibge derived for ${ibgeCount} estabelecimentos`)
      const ufCount = await deriveMunicipioUf(pool.db)
      cli.info(`uf derived for ${ufCount} municipios`)
    } finally {
      await pool.end()
    }
    break
  }
  case 'cnefe:uf': {
    const file = process.argv[3]
    const limitFlag = process.argv.indexOf('--limit')
    const limit = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : undefined
    if (!file) {
      throw new Error('usage: ingestor cnefe:uf <csv> [--limit N]')
    }
    const { ingestCnefeCsv } = await import('./cnefe.js')
    const pool = createDbPool(adminUrl, { max: 4 })
    try {
      const stats = await ingestCnefeCsv(pool.db, file, {
        ...(limit !== undefined ? { limit } : {}),
      })
      const rate = stats.elapsedMs > 0 ? Math.round((stats.rows / stats.elapsedMs) * 1000) : 0
      cli.info(
        `cnefe: ${stats.rows} rows, ${stats.skipped} skipped in ${Math.round(stats.elapsedMs / 1000)}s (${rate} rows/s)`,
      )
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
    cli.info(
      'comandos: fixtures | receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N] | policy:simulate <versao> [--report]',
    )
    cli.info('gate adiada (Fase 1): ingestao completa do dump real + medicao de tempo')
}
