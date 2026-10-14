import { createDbPool, runMigrations } from '@comprova/db'
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

const ingestEstabelecimentos = async (file: string, limit?: number): Promise<void> => {
  const { ingestReceitaEstabelecimentos } = await import('./receita-estabelecimentos.js')
  await runMigrations({ adminUrl, rolePassword: process.env.APP_DB_PASSWORD })
  const pool = createDbPool(adminUrl, { max: 4 })
  try {
    const stats = await ingestReceitaEstabelecimentos(pool.db, file, limit)
    console.log(`ingested ${stats.rows} rows into staging (snapshot ${stats.snapshotMonth})`)
    console.log('gate adiada: validar layout com o dump real e medir tempo de ingestao completa')
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
  case 'receita:estabelecimentos': {
    const file = process.argv[3]
    const limitFlag = process.argv.indexOf('--limit')
    const limit = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : undefined
    if (!file) {
      throw new Error('usage: ingestor receita:estabelecimentos <arquivo.csv> [--limit N]')
    }
    await ingestEstabelecimentos(file, limit)
    break
  }
  default:
    console.log(
      'comandos: fixtures | receita:estabelecimentos <csv> [--limit N] | policy:simulate <versao> [--report]',
    )
    console.log('gate adiada (Fase 1): ingestao completa do dump real + medicao de tempo')
}
