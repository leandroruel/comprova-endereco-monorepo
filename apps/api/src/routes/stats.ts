import { sql } from '@comprova/db'
import type { Db } from '@comprova/db'
import { withTenant } from '@comprova/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'

export interface StatsRoutesDeps {
  readonly db: Db
}

const StatsDto = z.object({
  total: z.number().int(),
  by_doc_type: z.record(z.string(), z.number().int()),
  by_verdict: z.record(z.string(), z.number().int()),
  completed: z.number().int(),
  partial: z.number().int(),
  failed: z.number().int(),
  avg_confidence: z.number().min(0).max(1),
  avg_score: z.number(),
})

export const registerStatsRoutes = (instance: FastifyInstance, deps: StatsRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/stats',
    {
      schema: {
        response: { 200: StatsDto },
      },
    },
    async (request) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const userId = request.sessionUser?.id ?? null

      const rows = (await withTenant(deps.db, tenant.tenantId, async (tx) => {
        const whereUser = userId !== null ? sql` AND user_id = ${userId}` : sql``
        const total = await tx.execute(sql`
          SELECT COUNT(*)::int as n FROM validation WHERE true${whereUser}
        `)
        const byDoc = await tx.execute(sql`
          SELECT s.doc_type::text as t, COUNT(*)::int as n
          FROM validation v
          JOIN subject s ON s.subject_id = v.subject_id
          WHERE true${whereUser}
          GROUP BY s.doc_type
        `)
        const byVerdict = await tx.execute(sql`
          SELECT COALESCE(v.verdict::text, 'PENDING') as v, COUNT(*)::int as n
          FROM validation v
          WHERE true${whereUser}
          GROUP BY v.verdict
        `)
        const byStatus = await tx.execute(sql`
          SELECT v.status::text as s, COUNT(*)::int as n
          FROM validation v
          WHERE true${whereUser}
          GROUP BY v.status
        `)
        const avg = await tx.execute(sql`
          SELECT COALESCE(AVG(v.confidence), 0)::float as conf, COALESCE(AVG(v.score), 0)::float as sc
          FROM validation v
          WHERE v.confidence IS NOT NULL AND true${whereUser}
        `)

        return {
          total: (total[0] as { n: number })?.n ?? 0,
          docTypes: byDoc as unknown as readonly { t: string; n: number }[],
          verdicts: byVerdict as unknown as readonly { v: string; n: number }[],
          statuses: byStatus as unknown as readonly { s: string; n: number }[],
          avg: (avg[0] as { conf: number; sc: number }) ?? { conf: 0, sc: 0 },
        }
      })) as unknown as {
        total: number
        docTypes: readonly { t: string; n: number }[]
        verdicts: readonly { v: string; n: number }[]
        statuses: readonly { s: string; n: number }[]
        avg: { conf: number; sc: number }
      }

      const docTypeMap: Record<string, number> = {}
      for (const row of rows.docTypes) docTypeMap[row.t] = row.n

      const verdictMap: Record<string, number> = {}
      for (const row of rows.verdicts) verdictMap[row.v] = row.n

      const statusMap: Record<string, number> = {}
      for (const row of rows.statuses) statusMap[row.s] = (statusMap[row.s] ?? 0) + row.n

      return {
        total: rows.total,
        by_doc_type: docTypeMap,
        by_verdict: verdictMap,
        completed: statusMap['completed'] ?? 0,
        partial: statusMap['partial'] ?? 0,
        failed: (statusMap['failed'] ?? 0) + (statusMap['queued'] ?? 0),
        avg_confidence: rows.avg.conf ?? 0,
        avg_score: rows.avg.sc ?? 0,
      }
    },
  )
}
