import { sql } from '@comprova/db'
import type { Db } from '@comprova/db'

export const ensurePartitions = async (db: Db, monthsAhead = 6): Promise<number> => {
  const now = new Date()
  let created = 0
  for (let i = -2; i <= monthsAhead; i++) {
    const month = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const start = month.toISOString().slice(0, 10)
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString().slice(0, 10)
    const suffix = `${month.getFullYear()}_${String(month.getMonth() + 1).padStart(2, '0')}`
    for (const table of ['validation', 'signal', 'usage_event']) {
      const result = (await db.execute(
        sql.raw(`
        SELECT COUNT(*) AS n FROM pg_class
        WHERE relname = '${table}_${suffix}'
      `),
      )) as unknown as readonly { n: number }[]
      const exists = Number((result[0] as { n: number } | undefined)?.n ?? 0) > 0
      if (!exists) {
        await db.execute(
          sql.raw(`
          CREATE TABLE IF NOT EXISTS ${table}_${suffix}
          PARTITION OF ${table}
          FOR VALUES FROM ('${start}') TO ('${end}')
        `),
        )
        created++
      }
    }
  }
  return created
}

export const startPartitionLoop = (db: Db, intervalMs = 86_400_000): (() => void) => {
  const timer = setInterval(() => {
    void ensurePartitions(db).catch(() => undefined)
  }, intervalMs)
  return () => clearInterval(timer)
}
