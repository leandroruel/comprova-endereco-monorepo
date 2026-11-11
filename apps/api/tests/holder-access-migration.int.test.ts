import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createDbPool, defaultMigrationsDir, getTableConfig, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const admin = postgres(db.adminUrl, { max: 1 })
const appPool = createDbPool(db.appUrl)

const migrationSql = await readFile(path.join(defaultMigrationsDir(), '0058_holder_access.sql'), 'utf8')

/** Extrai o bloco de assertions do resolver (não o bloco de criação do role). */
const membershipAssertion = [...migrationSql.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)]
  .map((match) => match[0])
  .find((block) => block.includes('holder_token_resolver role missing'))

if (membershipAssertion === undefined) {
  throw new Error('assertion do holder_token_resolver não encontrada na migration 0058')
}

const TABLES = [t.holderAccessToken, t.holderItemResponse, t.holderInformationRequestDocument]

interface TableFacts {
  readonly standaloneIndexes: readonly string[]
  readonly checkConstraints: readonly string[]
  readonly foreignKeys: readonly string[]
  readonly uniqueConstraints: readonly string[]
}

const factsOf = async (tableName: string): Promise<TableFacts> => {
  const indexes = await admin`
    SELECT i.relname AS name
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class tbl ON tbl.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = tbl.relnamespace
      LEFT JOIN pg_constraint c
        ON c.conindid = i.oid AND c.contype IN ('p', 'u')
     WHERE n.nspname = 'public'
       AND tbl.relname = ${tableName}
       AND c.oid IS NULL`
  const constraints = await admin`
    SELECT c.conname AS name, c.contype AS type
      FROM pg_constraint c
      JOIN pg_class tbl ON tbl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = tbl.relnamespace
     WHERE n.nspname = 'public'
       AND tbl.relname = ${tableName}`

  const namesOf = (type: string): readonly string[] =>
    constraints
      .filter((row) => row.type === type)
      .map((row) => row.name as string)
      .toSorted()

  return {
    standaloneIndexes: indexes.map((row) => row.name as string).toSorted(),
    checkConstraints: namesOf('c'),
    foreignKeys: namesOf('f'),
    uniqueConstraints: namesOf('u'),
  }
}

const declaredFactsOf = (table: (typeof TABLES)[number]): TableFacts => {
  const config = getTableConfig(table)
  return {
    standaloneIndexes: config.indexes
      .map((entry) => entry.config.name)
      .filter((name): name is string => name !== undefined)
      .toSorted(),
    checkConstraints: config.checks.map((entry) => entry.name).toSorted(),
    foreignKeys: config.foreignKeys.map((entry) => entry.getName()).toSorted(),
    uniqueConstraints: config.uniqueConstraints
      .map((entry) => entry.getName())
      .filter((name): name is string => name !== undefined)
      .toSorted(),
  }
}

afterAll(async () => {
  await admin.end()
  await appPool.end()
  await db.stop()
})

describe('F4.2 — drift entre schemas Drizzle e migration 0058', () => {
  it('índices, checks, FKs e uniques declarados correspondem exatamente ao banco', async () => {
    for (const table of TABLES) {
      const declared = declaredFactsOf(table)
      const actual = await factsOf(getTableConfig(table).name)
      expect(actual, `drift na tabela ${getTableConfig(table).name}`).toEqual(declared)
    }
  })

  it('índices parciais têm exatamente os predicados declarados', async () => {
    const rows = await admin`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_holder_access_token_active', 'idx_holder_information_request_document_pending')`
    const byName = new Map(rows.map((row) => [row.indexname as string, row.indexdef as string]))

    expect(byName.get('idx_holder_access_token_active')).toMatch(/WHERE \(revoked_at IS NULL\)/)
    expect(byName.get('idx_holder_information_request_document_pending')).toMatch(
      /WHERE \(\(?upload_state\)?(::text)? = 'pending'::text\)/,
    )
  })

  it('constraint de expiração do token existe e rejeita expires_at <= created_at', async () => {
    const rows = await admin`
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class tbl ON tbl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = tbl.relnamespace
       WHERE n.nspname = 'public'
         AND tbl.relname = 'holder_access_token'
         AND c.conname = 'holder_access_token_expiry_check'`
    expect(rows).toHaveLength(1)
  })
})

describe('F4.2 — assertion de memberships do holder_token_resolver', () => {
  const cleanup = async (): Promise<void> => {
    // Remove qualquer membership em ambos os sentidos antes de dropar o role
    // de teste. Nunca removemos memberships do próprio resolver: a migration
    // falha se elas existirem.
    await admin.unsafe(`
      DO $$
      DECLARE v_role record;
      BEGIN
        FOR v_role IN
          SELECT DISTINCT r.rolname
            FROM pg_auth_members m
            JOIN pg_roles r ON r.oid = m.member OR r.oid = m.roleid
           WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'holder_token_resolver')
              OR m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'holder_token_resolver')
        LOOP
          IF v_role.rolname NOT IN ('holder_token_resolver', 'app_user') THEN
            EXECUTE format('DROP ROLE IF EXISTS %I', v_role.rolname);
          END IF;
        END LOOP;
      END $$;
    `)
  }

  it('passa quando o resolver não participa de nenhuma membership', async () => {
    await expect(admin.unsafe(membershipAssertion)).resolves.toBeDefined()
  })

  it('falha quando outra role é membro do holder_token_resolver', async () => {
    await cleanup()
    await admin.unsafe('CREATE ROLE f42_member_of_resolver')
    await admin.unsafe('GRANT holder_token_resolver TO f42_member_of_resolver')

    await expect(admin.unsafe(membershipAssertion)).rejects.toThrow(
      /must not participate in any role membership/,
    )

    await cleanup()
  })

  it('falha quando o holder_token_resolver é membro de outra role', async () => {
    await cleanup()
    await admin.unsafe('CREATE ROLE f42_resolver_parent')
    await admin.unsafe('GRANT f42_resolver_parent TO holder_token_resolver')

    await expect(admin.unsafe(membershipAssertion)).rejects.toThrow(
      /must not participate in any role membership/,
    )

    await cleanup()
  })

  it('a migration original volta a passar após a limpeza', async () => {
    await cleanup()
    await expect(admin.unsafe(membershipAssertion)).resolves.toBeDefined()
  })
})
