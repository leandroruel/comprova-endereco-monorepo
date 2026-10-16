import { sql, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'

export const getStats = async (db: Db, tenantId: string, userId: string | null) => {
  const rows = (await withTenant(db, tenantId, async (tx) => {
    const whereUser = userId !== null ? sql` AND user_id = ${userId}` : sql``
    const total = await tx.execute(sql`
      SELECT COUNT(*)::int as n FROM validation WHERE true${whereUser}
    `)
    const uniqueDocs = await tx.execute(sql`
      SELECT COUNT(DISTINCT s.doc_hmac)::int as n
      FROM validation v
      JOIN subject s ON s.subject_id = v.subject_id
      WHERE true${whereUser}
    `)
    const byDoc = await tx.execute(sql`
      SELECT s.doc_type::text as t, COUNT(DISTINCT s.doc_hmac)::int as n
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
      uniqueDocs: (uniqueDocs[0] as { n: number })?.n ?? 0,
      docTypes: byDoc as unknown as readonly { t: string; n: number }[],
      verdicts: byVerdict as unknown as readonly { v: string; n: number }[],
      statuses: byStatus as unknown as readonly { s: string; n: number }[],
      avg: (avg[0] as { conf: number; sc: number }) ?? { conf: 0, sc: 0 },
    }
  })) as unknown as {
    total: number
    uniqueDocs: number
    docTypes: readonly { t: string; n: number }[]
    verdicts: readonly { v: string; n: number }[]
    statuses: readonly { s: string; n: number }[]
    avg: { conf: number; sc: number }
  }

  const byDocType: Record<string, number> = {}
  for (const row of rows.docTypes) byDocType[row.t] = row.n

  const byVerdict: Record<string, number> = {}
  for (const row of rows.verdicts) byVerdict[row.v] = row.n

  const byStatus: Record<string, number> = {}
  for (const row of rows.statuses) byStatus[row.s] = (byStatus[row.s] ?? 0) + row.n

  return {
    total: rows.total,
    unique_documents: rows.uniqueDocs,
    by_doc_type: byDocType,
    by_verdict: byVerdict,
    completed: byStatus['completed'] ?? 0,
    partial: byStatus['partial'] ?? 0,
    failed: (byStatus['failed'] ?? 0) + (byStatus['queued'] ?? 0),
    avg_confidence: rows.avg.conf ?? 0,
    avg_score: rows.avg.sc ?? 0,
  }
}
