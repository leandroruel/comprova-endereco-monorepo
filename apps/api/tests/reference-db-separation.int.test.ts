import {
  createApiKey,
  createTenant,
  seedGoldenDataset,
  startTestDb,
  startTestRedis,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import {
  createDbPool,
  defaultReferenceMigrationsDir,
  migrateReferenceData,
  runMigrations,
  sql,
} from '@comprova/db'
import { createLogger, createMetrics } from '@comprova/observability'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

/**
 * Prova da separação `comprova_app` / `comprova_reference` (mesma instância
 * PostgreSQL, dois databases):
 *
 *   1. golden dataset semeado no modo single-database (estado legado);
 *   2. migrations do database de referência aplicadas independentemente;
 *   3. dados de referência copiados via pipeline COPY com validação por contagem;
 *   4. a API com `referenceDb` resolve TODAS as leituras de referência no NOVO
 *      database — provado derrubando as tabelas ref_* do database operacional e
 *      mantendo `/v1/meta` funcional;
 *   5. escrita de `app_user` no database de referência é recusada (42501);
 *   6. dados operacionais (address_profile/tenant) permanecem no operacional.
 */

const PEPPER = 'test-pepper-123'

const db = await startTestDb()

// Estado legado: tudo no database operacional (single-database).
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
await seedGoldenDataset(adminPool.db)

// Database de referência, no MESMO container: migrations independentes.
await runMigrations({
  adminUrl: db.referenceAdminUrl,
  migrationsDir: defaultReferenceMigrationsDir(),
  rolePassword: TEST_APP_DB_PASSWORD,
})
const refAdminPool = createDbPool(db.referenceAdminUrl)

// Migração de dados: origem apenas lida; destino validado por contagem.
const copy = await migrateReferenceData({
  sourceAdminUrl: db.adminUrl,
  targetAdminUrl: db.referenceAdminUrl,
})

const refReadPool = createDbPool(db.referenceAppUrl)
const refWriteProbePool = createDbPool(db.referenceAppUrl)

const testRedis = await startTestRedis()
const redis = new Redis(testRedis.url)

const appPool = createDbPool(db.appUrl)
const app = await buildApp({
  config: {
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedis.url,
    API_KEY_PEPPER: PEPPER,
    CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
    CREDENTIAL_SIGNING_KEYS: '[]',
    SIGNING_KEY_PROVIDER: 'local',
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    POLICY_VERSION: '2026.11.1',
    TERMS_VERSION: '1.0.0',
    TERMS_APPROVED: 'true',
    TERMS_DOCUMENT_HASH: 'sha256:abc123def456',
    WORKER_LOOPS: false,
  },
  db: appPool.db,
  referenceDb: refReadPool.db,
  redis,
  logger: createLogger({ level: 'silent' }),
  metrics: createMetrics(),
})

// Api key para o /v1/meta (RLS por tenant não bloqueia o meta global; a rota
// exige apenas autenticação e o token é validado antes da query).
const tenant = await createTenant(adminPool.db, { name: 'meta-tenant' })
const key = (await createApiKey(adminPool.db, tenant, PEPPER)).plaintext

afterAll(async () => {
  await app.close()
  redis.disconnect()
  await adminPool.end()
  await refAdminPool.end()
  await refReadPool.end()
  await refWriteProbePool.end()
  await appPool.end()
  await testRedis.stop()
  await db.stop()
})

const REF_TABLES = [
  'ref_receita_estabelecimento',
  'ref_receita_empresa',
  'ref_receita_socio',
  'ref_receita_simples',
  'ref_cnefe_address',
  'ref_cep',
  'ref_known_shared_address',
  'ref_receita_municipio',
  'ref_cnae_divisao_categoria',
  'ref_estabelecimento_history',
] as const

const fetchMeta = async () =>
  app.inject({
    method: 'GET',
    url: '/v1/meta',
    headers: { authorization: `Bearer ${key}` },
  })

describe('separação comprova_app / comprova_reference', () => {
  it('migra os dados de referência com contagens idênticas', () => {
    expect(copy.valid).toBe(true)
    for (const table of REF_TABLES) {
      const row = copy.tables.find((t) => t.table === table)
      expect(row, table).toBeDefined()
      // Golden não popula todas as tabelas (ex.: municípios, histórico SCD2).
      if (row?.sourceRows === 0) {
        expect(row.targetRows).toBe(0)
        continue
      }
      expect(row?.sourceRows).toBeGreaterThan(0)
      expect(row?.targetRows).toBe(row?.sourceRows)
    }
  })

  it('lê todas as bases de referência do database separado mesmo sem tabelas ref_* no database operacional', async () => {
    // Prova: derruba as estruturas de referência do database operacional no
    // container de teste (os dados já foram copiados para o database de
    // referência). Qualquer leitura residual do `db` quebraria o /v1/meta.
    for (const table of REF_TABLES) {
      await adminPool.db.execute(sql.raw(`DROP TABLE IF EXISTS ${table} CASCADE`))
    }

    const res = await fetchMeta()
    expect(res.statusCode).toBe(200)
    const payload = res.json() as {
      datasets: {
        ref_receita_estabelecimento: { snapshot_month: string | null }
        ref_cnefe_address: { census_year: number | null }
        ref_cep: { sources: string[] }
        address_profile: { computed_from_snapshot: string | null }
      }
    }
    expect(payload.datasets.ref_receita_estabelecimento.snapshot_month).toBe('2026-09-01')
    expect(payload.datasets.ref_cnefe_address.census_year).toBe(2022)
    expect(payload.datasets.ref_cep.sources).toEqual(['golden'])
    // Dado operacional segue no database operacional.
    expect(payload.datasets.address_profile.computed_from_snapshot).toBe('2026-09-01')
  })

  it('recusa escrita de app_user no database de referência', async () => {
    await expect(
      refWriteProbePool.db.execute(
        sql`INSERT INTO ref_cep (cep, uf, source) VALUES ('99999999', 'SP', 'test')`,
      ),
    ).rejects.toThrow(/permission denied|INSERT/i)
  })

  it('todas as foreign keys do database de referência ficam entre tabelas de referência', async () => {
    const rows = (await refAdminPool.db.execute(
      sql`SELECT con.conname, conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref
          FROM pg_constraint con
          JOIN pg_class cls ON cls.oid = con.conrelid
          WHERE con.contype = 'f' AND cls.relnamespace = 'public'::regnamespace`,
    )) as unknown as readonly { conname: string; tbl: string; ref: string }[]
    for (const fk of rows) {
      expect(fk.ref, fk.conname).toMatch(/^ref_/)
      expect(fk.tbl, fk.conname).toMatch(/^ref_/)
    }
  })

  it('tenant e datas operacionais permanecem no database operacional', async () => {
    await createTenant(adminPool.db, { name: 'separation-tenant' })
    const rows = (await adminPool.db.execute(sql`SELECT tenant_id FROM tenant`)) as unknown as readonly {
      tenant_id: string
    }[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('seedGoldenDataset resolve referência e operacional em conexões distintas', async () => {
    // Modo split, idempotente nas duas conexões.
    await seedGoldenDataset(adminPool.db, refAdminPool.db)
    const cepRows = (await refAdminPool.db.execute(
      sql`SELECT count(*)::int AS n FROM ref_cep`,
    )) as unknown as readonly { n: number }[]
    expect(cepRows[0]?.n).toBeGreaterThan(0)
  })
})
