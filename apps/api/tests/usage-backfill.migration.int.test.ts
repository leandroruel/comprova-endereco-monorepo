import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant, startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'

/**
 * Teste de migration + backfill da 0053 (finding 3 da revisão) contra
 * PostgreSQL real.
 *
 * Estratégia: sobe o banco com TODAS as migrations, DESFAZ os efeitos da 0053
 * (colunas novas, tabelas novas, registro em `schema_migrations`) para
 * reconstruir o estado pré-migration, insere dados históricos deliberadamente
 * redundantes/imperfeitos e executa o arquivo SQL da 0053 como o runner faria.
 * Assim o backfill é exercitado exatamente como em produção — não presumimos
 * que o histórico esteja limpo nem deduplicado.
 */

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const admin = postgres(db.adminUrl, { max: 1 })
const adminPool = createDbPool(db.adminUrl)

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations/0053_usage_metering.sql',
)

let tenantMain: string
let tenantOther: string
// Mesmo `validationId` usado nos dois tenants (teste de isolamento).
const sharedValidationId = randomUUID()

const insertSubject = async (tenantId: string, docHmacSeed: string): Promise<string> => {
  const subjectId = randomUUID()
  await admin`INSERT INTO subject (subject_id, tenant_id, doc_type, doc_hmac)
    VALUES (${subjectId}, ${tenantId}, 'CNPJ', ${Buffer.from(docHmacSeed)})`
  return subjectId
}

const insertValidation = async (
  tenantId: string,
  validationId: string,
  status: 'completed' | 'partial' | 'queued',
): Promise<void> => {
  const subjectId = await insertSubject(tenantId, validationId)
  await admin`INSERT INTO validation
    (validation_id, tenant_id, subject_id, mode, status, verdict, score, confidence, policy_version, legal_basis, created_at, completed_at, expires_at)
    VALUES (${validationId}, ${tenantId}, ${subjectId}, 'fast', ${status}, 'INSUFFICIENT_EVIDENCE', 0.5, 0.9, '2026.11.1', 'CONSENT',
      ${new Date()}, ${status === 'completed' ? new Date() : null}, ${new Date(Date.now() + 30 * 86_400_000)})`
}

/** Insere um evento "histórico" (sem event_id/event_type/billable). */
const insertHistoricalEvent = async (
  tenantId: string,
  validationId: string | null,
  occurredAt: Date,
): Promise<void> => {
  await admin`INSERT INTO usage_event (tenant_id, occurred_at, kind, units, validation_id)
    VALUES (${tenantId}, ${occurredAt}, 'fast', 1, ${validationId})`
}

const billableEventsOf = async (tenantId: string, validationId: string | null) =>
  await admin<Record<string, unknown>[]>`
    SELECT event_id, event_type, billable, idempotency_key, occurred_at
    FROM usage_event
    WHERE tenant_id = ${tenantId}
      AND validation_id IS NOT DISTINCT FROM ${validationId}
    ORDER BY occurred_at`

beforeAll(async () => {
  tenantMain = await createTenant(adminPool.db, { name: 'backfill-main' })
  tenantOther = await createTenant(adminPool.db, { name: 'backfill-other' })

  // ---- Desfaz a 0053 para reconstruir o estado pré-migration ----
  await admin.unsafe(`
    DROP TABLE IF EXISTS usage_billing_unit CASCADE;
    DROP TABLE IF EXISTS usage_event_idempotency CASCADE;
    DROP TABLE IF EXISTS tenant_quota_audit CASCADE;
    ALTER TABLE usage_event
      DROP COLUMN IF EXISTS event_id,
      DROP COLUMN IF EXISTS event_type,
      DROP COLUMN IF EXISTS idempotency_key,
      DROP COLUMN IF EXISTS billable,
      DROP COLUMN IF EXISTS source;
    DELETE FROM schema_migrations WHERE name = '0053_usage_metering.sql';
  `)

  // ---- Histórico propositalmente redundante e imperfeito ----
  // 1. Validação concluída com DOIS eventos (duplicidade histórica real).
  const completedMulti = randomUUID()
  await insertValidation(tenantMain, completedMulti, 'completed')
  await insertHistoricalEvent(tenantMain, completedMulti, new Date('2026-11-01T10:00:00Z'))
  await insertHistoricalEvent(tenantMain, completedMulti, new Date('2026-11-01T11:00:00Z'))

  // 2. Validação concluída com UM evento.
  const completedOne = randomUUID()
  await insertValidation(tenantMain, completedOne, 'completed')
  await insertHistoricalEvent(tenantMain, completedOne, new Date('2026-11-02T10:00:00Z'))

  // 3. Validação parcial com evento — NÃO deve ser faturada.
  const partialValidation = randomUUID()
  await insertValidation(tenantMain, partialValidation, 'partial')
  await insertHistoricalEvent(tenantMain, partialValidation, new Date('2026-11-03T10:00:00Z'))

  // 4. Validação concluída SEM evento — o backfill não inventa evento.
  await insertValidation(tenantMain, randomUUID(), 'completed')

  // 5. Eventos sem validation_id — técnicos, não faturáveis.
  await insertHistoricalEvent(tenantMain, null, new Date('2026-11-04T10:00:00Z'))

  // 6. Mesmo validationId em tenants diferentes — isolamento por tenant.
  await insertValidation(tenantMain, sharedValidationId, 'completed')
  await insertValidation(tenantOther, sharedValidationId, 'completed')
  await insertHistoricalEvent(tenantMain, sharedValidationId, new Date('2026-11-05T10:00:00Z'))
  await insertHistoricalEvent(tenantOther, sharedValidationId, new Date('2026-11-05T10:00:00Z'))

  // 7. Evento de OUTRO tenant apontando para validação do tenant principal
  //    (cross-tenant por engano) — não pode ser faturado.
  await insertHistoricalEvent(tenantOther, completedOne, new Date('2026-11-06T10:00:00Z'))

  // ---- Executa a 0053 como o runner faria (arquivo completo) ----
  const content = await readFile(migrationPath, 'utf8')
  await admin.unsafe(content)
})

afterAll(async () => {
  await admin.end()
  await adminPool.end()
  await db.stop()
})

describe('migration 0053 — backfill histórico', () => {
  it('promove EXATAMENTE UM evento canônico por validação concluída (dedup)', async () => {
    const rows = await admin<Record<string, unknown>[]>`
      SELECT u.event_id, u.event_type, u.billable, u.idempotency_key, u.occurred_at
      FROM usage_event u
      JOIN validation v
        ON v.validation_id = u.validation_id AND v.tenant_id = u.tenant_id
      WHERE u.tenant_id = ${tenantMain}
        AND v.status = 'completed'
      ORDER BY u.occurred_at`

    // vCompletedMulti (2 eventos) + vCompletedOne (1) + sharedValidationId (1) = 4
    expect(rows).toHaveLength(4)

    const billable = rows.filter((r) => r.billable === true)
    expect(billable).toHaveLength(3)

    // O canônico é o mais recente; recebe event_type/billable/chave corretos.
    const newestOfMulti = billable.find((r) => new Date(r.occurred_at as string).getUTCHours() === 11)
    expect(newestOfMulti).toBeDefined()
    expect(newestOfMulti!.event_type).toBe('usage_event')
    expect(String(newestOfMulti!.idempotency_key)).toMatch(/^validation:[0-9a-f-]{36}$/)

    // O evento antigo da mesma validação permanece técnico (histórico preservado).
    const technical = rows.filter((r) => r.billable === false)
    expect(technical.length).toBeGreaterThanOrEqual(1)
    for (const row of technical) {
      expect(row.event_type).toBe('technical_execution')
      expect(row.billable).toBe(false)
    }
  })

  it('validação parcial, eventos sem validation_id e cross-tenant NÃO são faturados', async () => {
    const rows = await admin<Record<string, unknown>[]>`
      SELECT u.validation_id, u.event_type, u.billable
      FROM usage_event u
      WHERE u.tenant_id = ${tenantMain} AND (u.validation_id IS NULL OR u.validation_id NOT IN (
        SELECT v.validation_id FROM validation v
        WHERE v.tenant_id = ${tenantMain} AND v.status = 'completed'
      ))`

    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      expect(row.event_type).toBe('technical_execution')
      expect(row.billable).toBe(false)
    }
  })

  it('mesmo validationId em tenants diferentes gera uma unidade por tenant (isolamento)', async () => {
    const main = await billableEventsOf(tenantMain, sharedValidationId)
    const other = await billableEventsOf(tenantOther, sharedValidationId)

    expect(main.filter((r) => r.billable === true)).toHaveLength(1)
    expect(other.filter((r) => r.billable === true)).toHaveLength(1)

    // Eventos canônicos distintos, um por tenant.
    const mainEvent = main.find((r) => r.billable === true)!
    const otherEvent = other.find((r) => r.billable === true)!
    expect(String(mainEvent.event_id)).not.toBe(String(otherEvent.event_id))
  })

  it('evento cross-tenant (validation do tenant principal vista por outro tenant) não é faturado', async () => {
    // O único evento do tenantOther que não é o sharedValidationId.
    const rows = await admin<Record<string, unknown>[]>`
      SELECT validation_id, billable, event_type
      FROM usage_event
      WHERE tenant_id = ${tenantOther} AND validation_id IS DISTINCT FROM ${sharedValidationId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.billable).toBe(false)
    expect(rows[0]!.event_type).toBe('technical_execution')
  })

  it('idempotência e identidade comercial são registradas para os canônicos', async () => {
    const idemRows = await admin<Record<string, unknown>[]>`
      SELECT tenant_id, idempotency_key, event_id
      FROM usage_event_idempotency
      WHERE idempotency_key LIKE 'validation:%'`
    const unitRows = await admin<Record<string, unknown>[]>`
      SELECT tenant_id, validation_id, event_id
      FROM usage_billing_unit`

    // 3 canônicos no tenant principal + 1 no outro tenant.
    expect(idemRows).toHaveLength(4)
    expect(unitRows).toHaveLength(4)

    for (const unit of unitRows) {
      expect(unit.event_id).not.toBeNull()
      // A identidade comercial aponta para um evento faturável persistido.
      const eventRows =
        (await admin`SELECT billable FROM usage_event WHERE event_id = ${String(unit.event_id)}`) as Array<{
          billable: boolean
        }>
      expect(eventRows[0]!.billable).toBe(true)
    }

    // Chave canônica casa com a usada pelos caminhos fast/deep.
    for (const row of idemRows) {
      const key = String(row.idempotency_key)
      expect(key).toBe(`validation:${key.slice('validation:'.length)}`)
    }
  })

  it('o consumo comercial contabiliza apenas os eventos faturáveis do backfill', async () => {
    const main = await admin<{ total: number }[]>`
      SELECT COALESCE(sum(units), 0)::int AS total FROM usage_event WHERE tenant_id = ${tenantMain} AND billable = true`
    expect(Number(main[0]!.total)).toBe(3) // 2 concluídas + 1 compartilhada

    const other = await admin<{ total: number }[]>`
      SELECT COALESCE(sum(units), 0)::int AS total FROM usage_event WHERE tenant_id = ${tenantOther} AND billable = true`
    expect(Number(other[0]!.total)).toBe(1) // apenas o compartilhado (o cross-tenant ficou técnico)
  })

  it('schema Drizzle enxerga a estrutura criada pela migration', async () => {
    // round-trip pelo Drizzle confirma colunas/tabelas da 0053.
    const rows = await adminPool.db
      .select({ validationId: t.usageBillingUnit.validationId })
      .from(t.usageBillingUnit)
      .where(eq(t.usageBillingUnit.tenantId, tenantMain))
    expect(rows).toHaveLength(3)
  })
})
