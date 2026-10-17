import { sql } from '@comprova/db'
import type { Db } from '@comprova/db'

const PARTITIONED_TABLES = ['validation', 'signal', 'usage_event'] as const
const MONTHS_BEHIND = 2

export interface PartitionPlan {
  readonly table: string
  readonly suffix: string
  readonly start: string
  readonly end: string
}

/** Planejamento puro: de `MONTHS_BEHIND` meses atrás até `monthsAhead` à frente. */
export const partitionPlan = (now: Date, monthsAhead = 6): readonly PartitionPlan[] => {
  const offsets = Array.from({ length: monthsAhead + MONTHS_BEHIND + 1 }, (_, index) => index - MONTHS_BEHIND)
  return offsets.flatMap((offset) => {
    const month = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    const start = month.toISOString().slice(0, 10)
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString().slice(0, 10)
    const suffix = `${month.getFullYear()}_${String(month.getMonth() + 1).padStart(2, '0')}`
    return PARTITIONED_TABLES.map((table) => ({ table, suffix, start, end }))
  })
}

const partitionExists = async (db: Db, name: string): Promise<boolean> => {
  const result = (await db.execute(
    sql.raw(`
        SELECT COUNT(*) AS n FROM pg_class
        WHERE relname = '${name}'
      `),
  )) as unknown as readonly { n: number }[]
  return Number((result[0] as { n: number } | undefined)?.n ?? 0) > 0
}

const createPartition = async (db: Db, plan: PartitionPlan): Promise<void> => {
  await db.execute(
    sql.raw(`
          CREATE TABLE IF NOT EXISTS ${plan.table}_${plan.suffix}
          PARTITION OF ${plan.table}
          FOR VALUES FROM ('${plan.start}') TO ('${plan.end}')
        `),
  )
}

export const ensurePartitions = async (db: Db, monthsAhead = 6): Promise<number> => {
  const plans = partitionPlan(new Date(), monthsAhead)
  return plans.reduce<Promise<number>>(async (accPromise, plan) => {
    const created = await accPromise
    if (await partitionExists(db, `${plan.table}_${plan.suffix}`)) return created
    await createPartition(db, plan)
    return created + 1
  }, Promise.resolve(0))
}
