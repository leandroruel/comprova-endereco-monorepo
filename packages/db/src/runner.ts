import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

export interface RunMigrationsOptions {
  readonly adminUrl: string
  readonly migrationsDir?: string
  readonly rolePassword?: string
}

export const defaultMigrationsDir = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', 'migrations')
}

interface MigrationFile {
  readonly name: string
  readonly content: string
}

const readMigrationFile =
  (dir: string) =>
  async (name: string): Promise<MigrationFile> => ({
    name,
    content: await readFile(path.join(dir, name), 'utf8'),
  })

const applySequentially =
  (client: postgres.Sql<Record<string, postgres.PostgresType>>) =>
  async (files: readonly MigrationFile[]): Promise<void> =>
    files.reduce(
      (chain, file) =>
        chain.then(() =>
          client.begin(async (tx) => {
            await tx.unsafe(file.content)
            await tx`INSERT INTO schema_migrations (name) VALUES (${file.name})`
          }),
        ),
      Promise.resolve(),
    )

export const runMigrations = async (opts: RunMigrationsOptions): Promise<void> => {
  const dir = opts.migrationsDir ?? defaultMigrationsDir()
  const client = postgres(opts.adminUrl, { max: 1 })
  try {
    await client`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`
    const appliedRows = (await client`SELECT name FROM schema_migrations`) as readonly {
      name: string
    }[]
    const applied = new Set(appliedRows.map((row) => row.name))
    const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).toSorted()
    const pending = names.filter((name) => !applied.has(name))
    const files = await Promise.all(pending.map(readMigrationFile(dir)))
    await applySequentially(client)(files)
    if (opts.rolePassword !== undefined) {
      const escaped = opts.rolePassword.replace(/'/g, "''")
      await client.unsafe(`ALTER ROLE app_user WITH LOGIN PASSWORD '${escaped}'`)
    }
  } finally {
    await client.end()
  }
}
