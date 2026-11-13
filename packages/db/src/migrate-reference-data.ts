import postgres from 'postgres'

/**
 * Migração de dados do database operacional para o database de referência.
 *
 * Reproduzível e idempotente: cada tabela já povoada no destino é pulada e
 * sempre revalidada por contagem. Os dados de ORIGEM (database operacional)
 * nunca são modificados — nenhuma escrita é aberta contra a fonte.
 *
 * Estratégia: ambos os databases vivem na MESMA instância PostgreSQL, então a
 * cópia roda INTEIRAMENTE no servidor via `dblink` (extensão contrib), um
 * `INSERT … SELECT FROM dblink(...)` por tabela com `fetch_size` alto. Sem
 * streaming linha a linha pelo cliente, sem buffer em memória e sem depender
 * dos streams COPY do postgres.js, que ficam presos em tabelas grandes.
 */

/** Tabelas de referência migradas, em ordem fixa (menor → maior volume). */
export const REFERENCE_TABLES = [
  'ref_cnae_divisao_categoria',
  'ref_receita_municipio',
  'ref_known_shared_address',
  'ref_receita_simples',
  'ref_receita_empresa',
  'ref_cnefe_address',
  'ref_cep',
  'ref_receita_socio',
  'ref_estabelecimento_history',
  'ref_receita_estabelecimento',
] as const

export interface MigrateReferenceDataOptions {
  /** Database operacional (fonte). Somente leitura. */
  readonly sourceAdminUrl: string
  /** Database de referência (destino). Requer role com INSERT (admin). */
  readonly targetAdminUrl: string
  /** Reescreve tabelas destino já povoadas (usa TRUNCATE no destino). Padrão: false. */
  readonly replace?: boolean
  readonly onProgress?: (message: string) => void
}

export interface TableMigrated {
  readonly table: string
  readonly sourceRows: number
  readonly targetRows: number
  readonly copiedRows: number
  readonly skippedBecausePopulated: boolean
}

export interface MigrateReferenceDataResult {
  readonly tables: readonly TableMigrated[]
  /** true quando sourceRows === targetRows para todas as tabelas. */
  readonly valid: boolean
}

type Sql = postgres.Sql<Record<string, postgres.PostgresType>>

const countRows = async (client: Sql, table: string): Promise<number> => {
  const rows = (await client.unsafe(`SELECT count(*)::bigint AS n FROM "${table}"`)) as unknown as readonly {
    n: number | string
  }[]
  return Number(rows[0]?.n ?? 0)
}

/**
 * Conexão dblink para a fonte. Ambos os databases estão obrigatoriamente na
 * MESMA instância, então a conexão é feita pelo socket unix local do próprio
 * postmaster (host/port explícitos não servem: a URL aponta para a porta
 * mapeada fora do container).
 */
const dblinkConnstring = async (target: Sql, sourceUrl: string): Promise<string> => {
  const url = new URL(sourceUrl)
  const dbname = url.pathname.replace(/^\//, '') || 'postgres'
  const user = url.username || 'postgres'
  const password = url.password || ''
  const portRows = (await target.unsafe(`SHOW port`)) as unknown as readonly { port: string | number }[]
  const port = String(portRows[0]?.port ?? '5432')
  const fragments = [`dbname=${dbname}`, `user=${user}`, `port=${port}`]
  if (password !== '') fragments.push(`password=${password}`)
  fragments.push(`connect_timeout=10`, `application_name=comprova-migrate-reference-data`)
  return fragments.join(' ')
}

interface ColumnMeta {
  readonly column_name: string
  readonly formatted_type: string
}

const columnsOf = async (client: Sql, table: string): Promise<readonly ColumnMeta[]> => {
  const rows = (await client.unsafe(
    `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS formatted_type
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class cls ON cls.oid = a.attrelid
     JOIN pg_catalog.pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public'
       AND cls.relname = $1
       AND a.attnum > 0
       AND a.attisdropped = false
     ORDER BY a.attnum`,
    [table],
  )) as unknown as readonly { column_name: string; formatted_type: string }[]
  const columns = rows.map((r) => ({ column_name: r.column_name, formatted_type: r.formatted_type }))
  if (columns.length === 0) throw new Error(`table ${table} not found in target database`)
  return columns
}

const quoteAll = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ')

export const migrateReferenceData = async (
  opts: MigrateReferenceDataOptions,
): Promise<MigrateReferenceDataResult> => {
  const log = opts.onProgress ?? (() => undefined)
  const source = postgres(opts.sourceAdminUrl, { max: 1 })
  const target = postgres(opts.targetAdminUrl, { max: 1 })

  try {
    // Confirma que o destino tem as estruturas (migrations de referência aplicadas).
    const presentRows = (await target.unsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...REFERENCE_TABLES]],
    )) as unknown as readonly { table_name: string }[]
    const present = new Set(presentRows.map((r) => r.table_name))
    const absent = REFERENCE_TABLES.filter((t) => !present.has(t))
    if (absent.length > 0) {
      throw new Error(
        `target database missing reference tables: ${absent.join(', ')}. Run reference migrations first.`,
      )
    }

    const ext = (await target.unsafe(
      `SELECT 1 FROM pg_extension WHERE extname = 'dblink'`,
    )) as unknown as readonly unknown[]
    if (ext.length === 0) {
      throw new Error(
        'target database missing dblink extension. Run reference migrations (0001_extensions.sql).',
      )
    }

    const connstring = await dblinkConnstring(target, opts.sourceAdminUrl)
    const tables: TableMigrated[] = []

    for (const table of REFERENCE_TABLES) {
      const sourceRows = await countRows(source, table)
      const targetRows = await countRows(target, table)
      let copiedRows = 0
      let skippedBecausePopulated = false

      if (targetRows > 0 && opts.replace !== true) {
        log(`migrate-reference: ${table} already populated (${targetRows} rows), skipping copy`)
        skippedBecausePopulated = true
      } else {
        if (opts.replace === true && targetRows > 0) {
          await target.unsafe(`TRUNCATE TABLE "${table}"`)
        }
        // Identificadores vêm do pg_catalog do destino, não de entrada do usuário.
        const columns = await columnsOf(target, table)
        const names = columns.map((c) => c.column_name)
        if (sourceRows > 0) {
          const tableAlias = columns.map((c) => `"${c.column_name}" ${c.formatted_type}`).join(', ')
          const statement = `INSERT INTO "${table}" (${quoteAll(names)})
            SELECT ${quoteAll(names)}
            FROM dblink($src$${connstring}$src$, $sql$SELECT ${quoteAll(names)} FROM "${table}"$sql$)
              AS src(${tableAlias})`
          await target.unsafe(statement)
          log(`migrate-reference: ${table} copied ${sourceRows} rows via dblink`)
        }
        copiedRows = await countRows(target, table)
        log(`migrate-reference: ${table} now has ${copiedRows} rows (${sourceRows} in source)`)
      }

      const finalRows = await countRows(target, table)
      tables.push({ table, sourceRows, targetRows: finalRows, copiedRows, skippedBecausePopulated })
    }

    const valid = tables.every((t) => t.sourceRows === t.targetRows)
    return { tables, valid }
  } finally {
    await source.end()
    await target.end()
  }
}
