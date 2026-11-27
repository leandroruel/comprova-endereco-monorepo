import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createDbPool, eq, runMigrations, sql } from '@comprova/db'
import * as t from '@comprova/db'
import { startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import type { BillingProvider, NormalizedWebhookEvent, ProviderSubscription } from './provider.js'
import { ProviderRegistry } from './provider-registry.js'
import { BillingPlanService } from './plan.service.js'
import { CustomerService } from './customer.service.js'
import { InvoiceService } from './invoice.service.js'
import { SubscriptionService } from './subscription.service.js'

const testDb = await startTestDb()
await runMigrations({ adminUrl: testDb.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })

const adminPool = createDbPool(testDb.adminUrl)
const appPool = createDbPool(testDb.appUrl)

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const PLAN_ID = '22222222-2222-4222-8222-222222222222'
const SUBSCRIPTION_ID = '33333333-3333-4333-8333-333333333333'
const PROVIDER_CUSTOMER_ID = 'cus_test_billing'
const PROVIDER_SUBSCRIPTION_ID = 'sub_test_billing'

const PERIOD_START = new Date('2026-01-01T00:00:00Z')
const PERIOD_END = new Date('2026-02-01T00:00:00Z')
const LOCAL_PAUSED_AT = new Date('2026-01-10T12:00:00Z')

const makeProviderSubscription = (overrides: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  id: PROVIDER_SUBSCRIPTION_ID,
  customerId: PROVIDER_CUSTOMER_ID,
  priceId: 'price_test',
  status: 'active',
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  trialStart: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  pausedAt: null,
  defaultPaymentMethodId: null,
  pauseCollection: null,
  metadata: {},
  items: [],
  ...overrides,
})

class FakeStripeProvider {
  readonly name = 'stripe'
  subscription: ProviderSubscription = makeProviderSubscription()
  subscriptionError: Error | null = null
  getSubscriptionCalls = 0

  async getSubscription(): Promise<ProviderSubscription | null> {
    this.getSubscriptionCalls++
    if (this.subscriptionError) {
      throw this.subscriptionError
    }
    return this.subscription
  }
}

const provider = new FakeStripeProvider()
const registry = new ProviderRegistry()
registry.register(provider as unknown as BillingProvider)

const customerService = new CustomerService(appPool.db, registry)
const invoiceService = new InvoiceService(appPool.db, registry, customerService)
const service = new SubscriptionService(
  appPool.db,
  registry,
  new BillingPlanService(appPool.db, registry),
  customerService,
  invoiceService,
)

const getLocalSubscription = async (): Promise<t.TenantSubscription> => {
  const [subscription] = await adminPool.db
    .select()
    .from(t.tenantSubscription)
    .where(eq(t.tenantSubscription.id, SUBSCRIPTION_ID))
    .limit(1)
  if (!subscription) {
    throw new Error('Local subscription not found')
  }
  return subscription
}

const getWebhookRow = async (eventId: string) => {
  const [row] = await adminPool.db
    .select()
    .from(t.providerWebhookEvent)
    .where(
      sql`${t.providerWebhookEvent.providerName} = 'stripe' AND ${t.providerWebhookEvent.providerEventId} = ${eventId}`,
    )
    .limit(1)
  return row
}

const handleSubscriptionEvent = (eventId: string) =>
  service.handleWebhookEvent({
    type: 'subscription.updated',
    providerName: 'stripe',
    providerEventId: eventId,
    providerSubscriptionId: PROVIDER_SUBSCRIPTION_ID,
    providerCustomerId: PROVIDER_CUSTOMER_ID,
    payload: {},
  })

const resetLocalSubscription = async (overrides: Partial<t.NewTenantSubscription> = {}) => {
  await adminPool.db
    .update(t.tenantSubscription)
    .set({
      status: 'active',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      trialStart: null,
      trialEnd: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      pausedAt: null,
      paymentMethodId: null,
      ...overrides,
    })
    .where(eq(t.tenantSubscription.id, SUBSCRIPTION_ID))
}

await adminPool.db.insert(t.tenant).values({
  tenantId: TENANT_ID,
  name: 'billing-webhook-test',
  providerName: 'stripe',
  stripeCustomerId: PROVIDER_CUSTOMER_ID,
})

await adminPool.db.insert(t.billingPlan).values({
  id: PLAN_ID,
  name: 'Plano de teste',
  slug: 'plano-de-teste',
  billingModel: 'postpaid',
  currency: 'BRL',
  providerName: 'stripe',
  providerProductId: 'prod_test',
  providerPriceId: 'price_test',
  monthlyPriceMicros: 0,
  includedValidations: 0,
})

await adminPool.db.insert(t.tenantSubscription).values({
  id: SUBSCRIPTION_ID,
  tenantId: TENANT_ID,
  planId: PLAN_ID,
  providerName: 'stripe',
  providerCustomerId: PROVIDER_CUSTOMER_ID,
  providerSubscriptionId: PROVIDER_SUBSCRIPTION_ID,
  status: 'active',
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  billingCycleAnchor: PERIOD_START,
})

beforeEach(async () => {
  provider.subscription = makeProviderSubscription()
  provider.subscriptionError = null
  provider.getSubscriptionCalls = 0
  await resetLocalSubscription()
  await adminPool.db.delete(t.providerWebhookEvent)
})

afterAll(async () => {
  await adminPool.end()
  await appPool.end()
  await testDb.stop()
})

describe('sync de campos opcionais da subscription', () => {
  it('preenche trial quando o provider passa a informar', async () => {
    const trialStart = new Date('2026-01-02T00:00:00Z')
    const trialEnd = new Date('2026-01-09T00:00:00Z')
    provider.subscription = makeProviderSubscription({ trialStart, trialEnd })

    await handleSubscriptionEvent('evt_trial_set')

    const local = await getLocalSubscription()
    expect(local.trialStart).toEqual(trialStart)
    expect(local.trialEnd).toEqual(trialEnd)
  })

  it('limpa trial quando o provider deixa de ter trial', async () => {
    await resetLocalSubscription({
      trialStart: new Date('2026-01-02T00:00:00Z'),
      trialEnd: new Date('2026-01-09T00:00:00Z'),
    })

    await handleSubscriptionEvent('evt_trial_cleared')

    const local = await getLocalSubscription()
    expect(local.trialStart).toBeNull()
    expect(local.trialEnd).toBeNull()
  })

  it('limpa canceledAt ao descancelar', async () => {
    await resetLocalSubscription({
      status: 'canceled',
      canceledAt: new Date('2026-01-05T00:00:00Z'),
      cancelAtPeriodEnd: true,
    })

    await handleSubscriptionEvent('evt_uncanceled')

    const local = await getLocalSubscription()
    expect(local.status).toBe('active')
    expect(local.canceledAt).toBeNull()
    expect(local.cancelAtPeriodEnd).toBe(false)
  })

  it('atualiza o payment method e limpa quando removido', async () => {
    await resetLocalSubscription({ paymentMethodId: 'pm_old' })
    provider.subscription = makeProviderSubscription({ defaultPaymentMethodId: 'pm_new' })

    await handleSubscriptionEvent('evt_pm_changed')
    expect((await getLocalSubscription()).paymentMethodId).toBe('pm_new')

    provider.subscription = makeProviderSubscription({ defaultPaymentMethodId: null })
    await handleSubscriptionEvent('evt_pm_removed')
    expect((await getLocalSubscription()).paymentMethodId).toBeNull()
  })

  it('repetir a sincronização não altera os valores já sincronizados', async () => {
    const trialStart = new Date('2026-01-02T00:00:00Z')
    const trialEnd = new Date('2026-01-09T00:00:00Z')
    provider.subscription = makeProviderSubscription({ trialStart, trialEnd })

    await handleSubscriptionEvent('evt_repeat_1')
    const first = await getLocalSubscription()

    await handleSubscriptionEvent('evt_repeat_2')
    const second = await getLocalSubscription()

    expect(second.trialStart).toEqual(first.trialStart)
    expect(second.trialEnd).toEqual(first.trialEnd)
    expect(second.status).toBe(first.status)
  })
})

describe('subscriptions pausadas', () => {
  it('subscription ativa sem pause_collection permanece ativa e limpa pausedAt', async () => {
    await resetLocalSubscription({ pausedAt: LOCAL_PAUSED_AT })

    await handleSubscriptionEvent('evt_not_paused')

    const local = await getLocalSubscription()
    expect(local.status).toBe('active')
    expect(local.pausedAt).toBeNull()
  })

  it('pause_collection ativa marca a subscription local como paused sem inventar data', async () => {
    await resetLocalSubscription({ status: 'paused', pausedAt: LOCAL_PAUSED_AT })
    provider.subscription = makeProviderSubscription({
      status: 'active',
      pausedAt: undefined,
      pauseCollection: { behavior: 'keep_as_draft', resumesAt: null },
    })

    await handleSubscriptionEvent('evt_collection_paused')

    const local = await getLocalSubscription()
    expect(local.status).toBe('paused')
    expect(local.pausedAt).toEqual(LOCAL_PAUSED_AT)
  })

  it('retomada após pausa volta para active e limpa pausedAt', async () => {
    await resetLocalSubscription({ status: 'paused', pausedAt: LOCAL_PAUSED_AT })

    await handleSubscriptionEvent('evt_resumed')

    const local = await getLocalSubscription()
    expect(local.status).toBe('active')
    expect(local.pausedAt).toBeNull()
  })

  it('sincronizações repetidas não geram um novo pausedAt', async () => {
    await resetLocalSubscription({ status: 'paused', pausedAt: LOCAL_PAUSED_AT })
    provider.subscription = makeProviderSubscription({
      status: 'active',
      pausedAt: undefined,
      pauseCollection: { behavior: 'void', resumesAt: null },
    })

    await handleSubscriptionEvent('evt_paused_repeat_1')
    await handleSubscriptionEvent('evt_paused_repeat_2')

    const local = await getLocalSubscription()
    expect(local.status).toBe('paused')
    expect(local.pausedAt).toEqual(LOCAL_PAUSED_AT)
  })
})

describe('persistência e idempotência de webhooks', () => {
  it('primeiro recebimento processa e marca o evento como concluído', async () => {
    provider.subscription = makeProviderSubscription({
      trialStart: new Date('2026-01-02T00:00:00Z'),
    })

    await handleSubscriptionEvent('evt_first')

    const row = await getWebhookRow('evt_first')
    expect(row?.processedAt).not.toBeNull()
    expect(row?.processingError).toBeNull()
    expect(row?.retryCount).toBe(0)
    expect(provider.getSubscriptionCalls).toBe(1)
    expect((await getLocalSubscription()).trialStart).toEqual(new Date('2026-01-02T00:00:00Z'))
  })

  it('evento já processado não executa os efeitos de negócio novamente', async () => {
    provider.subscription = makeProviderSubscription({
      trialStart: new Date('2026-01-02T00:00:00Z'),
    })
    await handleSubscriptionEvent('evt_duplicate')

    const processedAt = (await getWebhookRow('evt_duplicate'))?.processedAt

    // Se o evento fosse reprocessado, o trial local mudaria.
    provider.subscription = makeProviderSubscription({
      trialStart: new Date('2026-01-03T00:00:00Z'),
    })
    await handleSubscriptionEvent('evt_duplicate')

    const row = await getWebhookRow('evt_duplicate')
    expect(provider.getSubscriptionCalls).toBe(1)
    expect(row?.processedAt).toEqual(processedAt)
    expect((await getLocalSubscription()).trialStart).toEqual(new Date('2026-01-02T00:00:00Z'))
  })

  it('duas entregas concorrentes do mesmo evento processam uma única vez', async () => {
    await Promise.all([handleSubscriptionEvent('evt_concurrent'), handleSubscriptionEvent('evt_concurrent')])

    const row = await getWebhookRow('evt_concurrent')
    expect(provider.getSubscriptionCalls).toBe(1)
    expect(row?.processedAt).not.toBeNull()
  })

  it('falha durante o processamento registra o erro e não marca como concluído', async () => {
    provider.subscriptionError = new Error('provider unavailable')

    await expect(handleSubscriptionEvent('evt_failed')).rejects.toThrow('provider unavailable')

    const row = await getWebhookRow('evt_failed')
    expect(row?.processedAt).toBeNull()
    expect(row?.processingError).toContain('provider unavailable')
    // A transação de negócio foi revertida.
    expect((await getLocalSubscription()).trialStart).toBeNull()
  })

  it('reprocessa um evento que falhou anteriormente', async () => {
    provider.subscriptionError = new Error('provider unavailable')
    await expect(handleSubscriptionEvent('evt_retry')).rejects.toThrow('provider unavailable')

    provider.subscriptionError = null
    provider.subscription = makeProviderSubscription({
      trialStart: new Date('2026-01-02T00:00:00Z'),
    })
    await handleSubscriptionEvent('evt_retry')

    const row = await getWebhookRow('evt_retry')
    expect(row?.processedAt).not.toBeNull()
    expect(row?.processingError).toBeNull()
    expect(row?.retryCount).toBe(1)
    expect((await getLocalSubscription()).trialStart).toEqual(new Date('2026-01-02T00:00:00Z'))
  })

  it('eventos diferentes para a mesma subscription são processados', async () => {
    await handleSubscriptionEvent('evt_same_sub_1')
    await handleSubscriptionEvent('evt_same_sub_2')

    expect(provider.getSubscriptionCalls).toBe(2)
    expect((await getWebhookRow('evt_same_sub_1'))?.processedAt).not.toBeNull()
    expect((await getWebhookRow('evt_same_sub_2'))?.processedAt).not.toBeNull()
  })

  it('não confia em tenant informado no payload: usa o customer do provider', async () => {
    const event: NormalizedWebhookEvent = {
      type: 'subscription.updated',
      providerName: 'stripe',
      providerEventId: 'evt_foreign_tenant',
      providerSubscriptionId: PROVIDER_SUBSCRIPTION_ID,
      providerCustomerId: PROVIDER_CUSTOMER_ID,
      payload: { comprova_tenant_id: '99999999-9999-4999-8999-999999999999' },
    }

    await service.handleWebhookEvent(event)

    expect((await getWebhookRow('evt_foreign_tenant'))?.processedAt).not.toBeNull()
    expect((await getLocalSubscription()).tenantId).toBe(TENANT_ID)
  })
})
