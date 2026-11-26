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

describe('F4.2 — assertion de atributos e grants do holder_token_resolver', () => {
  it('passa quando o resolver não tem memberships perigosos nem CREATE no schema public', async () => {
    await expect(admin.unsafe(membershipAssertion)).resolves.toBeDefined()
  })

  it('falha quando holder_token_resolver tem CREATE direto no schema public', async () => {
    await admin.unsafe('GRANT CREATE ON SCHEMA public TO holder_token_resolver')

    await expect(admin.unsafe(membershipAssertion)).rejects.toThrow(
      /holder_token_resolver retains a direct CREATE grant on schema public/,
    )

    await admin.unsafe('REVOKE CREATE ON SCHEMA public FROM holder_token_resolver')
  })

  it('falha quando holder_token_resolver tem CREATE efetivo no schema public via PUBLIC', async () => {
    // Concede CREATE ao PUBLIC (que afeta todos os roles, inclusive holder_token_resolver)
    await admin.unsafe('GRANT CREATE ON SCHEMA public TO PUBLIC')

    await expect(admin.unsafe(membershipAssertion)).rejects.toThrow(
      /holder_token_resolver has effective CREATE on schema public/,
    )

    await admin.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
  })

  it('a migration original volta a passar após a limpeza', async () => {
    await expect(admin.unsafe(membershipAssertion)).resolves.toBeDefined()
  })

  it('falha da assertion não deixa alterações parciais (rollback transacional)', async () => {
    try {
      await admin.unsafe('GRANT CREATE ON SCHEMA public TO holder_token_resolver')

      // A migration roda cada arquivo em uma transação (runner). Simula-se uma
      // alteração anterior no mesmo arquivo e verifica-se que a falha da
      // assertion desfaz tudo, sem estado parcial.
      await expect(
        admin.begin(async (tx) => {
          await tx.unsafe('CREATE TABLE f42_partial_marker (id integer)')
          await tx.unsafe(membershipAssertion)
        }),
      ).rejects.toThrow(/holder_token_resolver retains a direct CREATE grant on schema public/)

      const [marker] = await admin`SELECT to_regclass('public.f42_partial_marker') AS marker`
      expect(marker!.marker).toBeNull()
    } finally {
      await admin.unsafe('REVOKE CREATE ON SCHEMA public FROM holder_token_resolver')
    }
  })
})

describe('F4.2 — privilégios efetivos do holder_token_resolver', () => {
  it('mantém os atributos seguros após a migration', async () => {
    const [role] = await admin`
      SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
             rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = 'holder_token_resolver'`

    expect(role).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    })
  })

  it('só tem SELECT na tabela de tokens e nenhum CREATE em public', async () => {
    const grants = await admin`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'holder_token_resolver'
       ORDER BY table_name, privilege_type`
    expect(grants).toEqual([{ table_name: 'holder_access_token', privilege_type: 'SELECT' }])

    const [schema] = await admin`
      SELECT has_schema_privilege('holder_token_resolver', 'public', 'CREATE') AS can_create`
    expect(schema!.can_create).toBe(false)

    const [table] = await admin`
      SELECT has_table_privilege('holder_token_resolver', 'holder_access_token', 'SELECT') AS can_select,
             has_table_privilege('holder_token_resolver', 'holder_access_token', 'INSERT') AS can_insert,
             has_table_privilege('holder_token_resolver', 'holder_access_token', 'UPDATE') AS can_update,
             has_table_privilege('holder_token_resolver', 'holder_access_token', 'DELETE') AS can_delete`
    expect(table).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    })
  })
})
