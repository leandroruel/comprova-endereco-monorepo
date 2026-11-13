import { randomUUID } from 'node:crypto'
import { createDbPool, eq, runMigrations } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { makeFakeObjectStore, type SafeFetch } from '@comprova/providers'
import { createTenant, startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { holderSubmissionProcessingTick } from '../../../../worker/src/modules/holder-submission-processing/holder-submission-processing.service.js'
import { publishTick } from '../../../src/modules/webhooks/outbox-publisher.js'
import { encryptSecret } from '../../../src/shared/secretbox.js'

const PEPPER = 'test-pepper-outbox-holder-isolation'
const logger = createLogger({ level: 'silent' })

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

interface EventInput {
  readonly eventType: string
  readonly aggregate: string
  readonly aggregateId: string
  readonly payload: Record<string, unknown>
}

const insertEvent = async (input: EventInput): Promise<number> => {
  const [row] = await adminPool.db
    .insert(t.outbox)
    .values({
      aggregate: input.aggregate,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload,
    })
    .returning({ outboxId: t.outbox.outboxId })
  if (row === undefined) throw new Error('failed to insert outbox event')
  return row.outboxId
}

const publishedAtOf = async (outboxId: number): Promise<Date | null> => {
  const [row] = await adminPool.db
    .select({ publishedAt: t.outbox.publishedAt })
    .from(t.outbox)
    .where(eq(t.outbox.outboxId, outboxId))
  return row?.publishedAt ?? null
}

const createEndpoint = async (tenantId: string, events: string[]): Promise<string> => {
  const endpointId = randomUUID()
  await adminPool.db.insert(t.webhookEndpoint).values({
    endpointId,
    tenantId,
    url: 'https://example.com/hook',
    secretEnc: encryptSecret(PEPPER, `whsec_${randomUUID()}`),
    events,
    active: true,
  })
  return endpointId
}

/** Solicitação completa, sem documentos: o tick do Holder cai no caminho "nada a fazer". */
const seedHolderRequest = async (tenantId: string): Promise<string> => {
  const holderId = randomUUID()
  await adminPool.db.insert(t.holder).values({
    holderId,
    tenantId,
    externalReference: `outbox-scope-${holderId}`,
    name: 'Titular do teste',
    documentHash: `hash-${holderId}`,
  })
  const requestId = randomUUID()
  await adminPool.db.insert(t.holderInformationRequest).values({
    id: requestId,
    tenantId,
    holderId,
    type: 'address_proof',
    purpose: 'test',
    items: [],
    state: 'completed',
    createdBy: 'outbox-scope-test',
  })
  return requestId
}

describe('isolamento do outbox entre webhooks e processamento do Holder', () => {
  it('não seleciona nem marca como publicado o evento interno, mesmo com endpoint inscrito', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'outbox-internal' })
    await createEndpoint(tenantId, ['holder_submission.processing_requested'])

    const outboxId = await insertEvent({
      eventType: 'holder_submission.processing_requested',
      aggregate: 'holder_information_request',
      aggregateId: randomUUID(),
      payload: {
        tenant_id: tenantId,
        holder_information_request_id: randomUUID(),
      },
    })

    await publishTick({ db: adminPool.db, pepper: PEPPER, logger })
    expect(await publishedAtOf(outboxId)).toBeNull()

    // Execução repetida não pode consumir o evento interno.
    await publishTick({ db: adminPool.db, pepper: PEPPER, logger })
    expect(await publishedAtOf(outboxId)).toBeNull()

    await adminPool.db.delete(t.outbox).where(eq(t.outbox.outboxId, outboxId))
  })

  it('publica normalmente um evento externo e entrega ao endpoint inscrito', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'outbox-external-delivery' })
    const endpointId = await createEndpoint(tenantId, ['validation.completed'])
    const validationId = randomUUID()
    const outboxId = await insertEvent({
      eventType: 'validation.completed',
      aggregate: 'validation',
      aggregateId: validationId,
      payload: { tenant_id: tenantId, validation_id: validationId },
    })

    const delivered: string[] = []
    const safeFetch: SafeFetch = (url) => {
      delivered.push(url)
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('ok'),
        address: '8.8.8.8',
      })
    }

    await publishTick({ db: adminPool.db, pepper: PEPPER, logger, safeFetch })

    expect(await publishedAtOf(outboxId)).not.toBeNull()
    const deliveries = await adminPool.db
      .select()
      .from(t.webhookDelivery)
      .where(eq(t.webhookDelivery.endpointId, endpointId))
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.status).toBe('delivered')
    expect(delivered).toHaveLength(1)
  })

  it('evento externo sem endpoint inscrito é publicado sem criação de entrega', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'outbox-external-no-endpoint' })
    const validationId = randomUUID()
    const outboxId = await insertEvent({
      eventType: 'validation.updated',
      aggregate: 'validation',
      aggregateId: validationId,
      payload: { tenant_id: tenantId, validation_id: validationId },
    })

    await publishTick({ db: adminPool.db, pepper: PEPPER, logger })

    expect(await publishedAtOf(outboxId)).not.toBeNull()
    const deliveries = await adminPool.db
      .select()
      .from(t.webhookDelivery)
      .where(eq(t.webhookDelivery.validationId, validationId))
    expect(deliveries).toHaveLength(0)
  })

  it('depois do publisher, o worker do Holder ainda encontra e processa o evento', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'outbox-holder-worker' })
    // Endpoint inscrito no evento interno: o publisher antigo o consumiria.
    await createEndpoint(tenantId, ['holder_submission.processing_requested'])
    const requestId = await seedHolderRequest(tenantId)

    const outboxId = await insertEvent({
      eventType: 'holder_submission.processing_requested',
      aggregate: 'holder_information_request',
      aggregateId: requestId,
      payload: { tenant_id: tenantId, holder_information_request_id: requestId },
    })

    await publishTick({ db: adminPool.db, pepper: PEPPER, logger })
    expect(await publishedAtOf(outboxId)).toBeNull()

    const processed = await holderSubmissionProcessingTick({
      db: adminPool.db,
      store: makeFakeObjectStore(),
      logger,
    })
    expect(processed).toBe(1)
    expect(await publishedAtOf(outboxId)).not.toBeNull()

    const rows = await adminPool.db
      .select({ state: t.holderSubmissionProcessing.state })
      .from(t.holderSubmissionProcessing)
      .where(eq(t.holderSubmissionProcessing.holderInformationRequestId, requestId))
    expect(rows.map((row) => row.state)).toEqual(['processed'])
  })
})
