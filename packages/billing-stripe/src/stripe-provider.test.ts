import { beforeEach, describe, expect, it, vi } from 'vitest'

const stripeMock = vi.hoisted(() => ({
  retrieveSubscription: vi.fn(),
  retrieveInvoice: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  createPrice: vi.fn(),
  createCreditNote: vi.fn(),
  constructEvent: vi.fn(),
}))

vi.mock('stripe', () => {
  class StripeError extends Error {
    code?: string
  }

  class StripeMock {
    static errors = { StripeError }

    subscriptions = { retrieve: stripeMock.retrieveSubscription }
    invoices = { retrieve: stripeMock.retrieveInvoice }
    paymentIntents = { retrieve: stripeMock.retrievePaymentIntent }
    prices = { create: stripeMock.createPrice }
    creditNotes = { create: stripeMock.createCreditNote }
    webhooks = { constructEvent: stripeMock.constructEvent }
  }

  return { default: StripeMock }
})

import type Stripe from 'stripe'
import type { ProviderWebhookEvent } from '@comprova/billing-core'
import { StripeProvider } from './stripe-provider.js'

const makeProvider = () => new StripeProvider({ secretKey: 'sk_test_123', webhookSecret: 'whsec_test_123' })

const makeSubscription = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'sub_123',
    object: 'subscription',
    customer: 'cus_123',
    status: 'active',
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_592_000,
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    pause_collection: null,
    default_payment_method: null,
    metadata: { comprova_tenant_id: 'tenant-1' },
    items: {
      data: [
        {
          id: 'si_123',
          price: { id: 'price_123', recurring: { usage_type: 'licensed' } },
          quantity: 2,
        },
      ],
    },
    ...overrides,
  }) as unknown as Stripe.Subscription

const makeLine = (overrides: Record<string, unknown> = {}) => ({
  id: 'il_123',
  object: 'line_item',
  amount: 1_000,
  currency: 'brl',
  description: 'Linha de teste',
  period: { start: 1_700_000_000, end: 1_702_592_000 },
  price: { id: 'price_123' },
  quantity: 2,
  proration: false,
  type: 'subscription',
  ...overrides,
})

const makeInvoice = (lines: ReadonlyArray<Record<string, unknown>>) =>
  ({
    id: 'in_123',
    object: 'invoice',
    subscription: 'sub_123',
    customer: 'cus_123',
    status: 'open',
    amount_due: 2_000,
    amount_paid: 0,
    currency: 'brl',
    hosted_invoice_url: null,
    invoice_pdf: null,
    period_start: 1_700_000_000,
    period_end: 1_702_592_000,
    due_date: null,
    status_transitions: { paid_at: null },
    lines: { data: lines },
    metadata: {},
  }) as unknown as Stripe.Invoice

const makeWebhookEvent = (
  type: string,
  data: Record<string, unknown>,
  id = 'evt_123',
): ProviderWebhookEvent => ({
  id,
  type,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  data,
  livemode: false,
})

beforeEach(() => {
  stripeMock.retrieveSubscription.mockReset()
  stripeMock.retrieveInvoice.mockReset()
  stripeMock.retrievePaymentIntent.mockReset()
  stripeMock.createPrice.mockReset()
  stripeMock.createCreditNote.mockReset()
  stripeMock.constructEvent.mockReset()
})

describe('StripeProvider.mapSubscription', () => {
  it('mapeia subscription ativa sem trial nem pausa', async () => {
    stripeMock.retrieveSubscription.mockResolvedValue(makeSubscription())

    const subscription = await makeProvider().getSubscription('sub_123')

    expect(subscription).toMatchObject({
      id: 'sub_123',
      customerId: 'cus_123',
      priceId: 'price_123',
      status: 'active',
      trialStart: null,
      trialEnd: null,
      canceledAt: null,
      defaultPaymentMethodId: null,
      pauseCollection: null,
      pausedAt: null,
      cancelAtPeriodEnd: false,
    })
    expect(subscription?.items).toEqual([
      { id: 'si_123', priceId: 'price_123', quantity: 2, usageType: 'licensed' },
    ])
  })

  it('mapeia trial preenchido', async () => {
    stripeMock.retrieveSubscription.mockResolvedValue(
      makeSubscription({
        status: 'trialing',
        trial_start: 1_700_000_000,
        trial_end: 1_701_000_000,
      }),
    )

    const subscription = await makeProvider().getSubscription('sub_123')

    expect(subscription?.status).toBe('trialing')
    expect(subscription?.trialStart).toEqual(new Date(1_700_000_000 * 1000))
    expect(subscription?.trialEnd).toEqual(new Date(1_701_000_000 * 1000))
  })

  it('mapeia cancelamento e default payment method expandido', async () => {
    stripeMock.retrieveSubscription.mockResolvedValue(
      makeSubscription({
        status: 'canceled',
        canceled_at: 1_700_500_000,
        default_payment_method: { id: 'pm_expanded' },
      }),
    )

    const subscription = await makeProvider().getSubscription('sub_123')

    expect(subscription?.canceledAt).toEqual(new Date(1_700_500_000 * 1000))
    expect(subscription?.defaultPaymentMethodId).toBe('pm_expanded')
  })

  it('mapeia incomplete_expired para canceled', async () => {
    stripeMock.retrieveSubscription.mockResolvedValue(makeSubscription({ status: 'incomplete_expired' }))

    const subscription = await makeProvider().getSubscription('sub_123')

    expect(subscription?.status).toBe('canceled')
  })

  it('diferencia pause_collection do status de ciclo de vida', async () => {
    stripeMock.retrieveSubscription.mockResolvedValue(
      makeSubscription({
        status: 'active',
        pause_collection: { behavior: 'keep_as_draft', resumes_at: null },
      }),
    )

    const subscription = await makeProvider().getSubscription('sub_123')

    expect(subscription?.status).toBe('active')
    expect(subscription?.pauseCollection).toEqual({
      behavior: 'keep_as_draft',
      resumesAt: null,
    })
    // Stripe não expõe a data de início da pausa: preservar o valor local.
    expect(subscription?.pausedAt).toBeUndefined()
  })

  it('mapeia resumes_at da pausa de cobrança', async () => {
    stripeMock.retrieveSubscription.mockResolvedValue(
      makeSubscription({
        pause_collection: { behavior: 'void', resumes_at: 1_701_000_000 },
      }),
    )

    const subscription = await makeProvider().getSubscription('sub_123')

    expect(subscription?.pauseCollection).toEqual({
      behavior: 'void',
      resumesAt: new Date(1_701_000_000 * 1000),
    })
  })
})

describe('StripeProvider.mapInvoice', () => {
  const getLineType = async (line: Record<string, unknown>) => {
    stripeMock.retrieveInvoice.mockResolvedValue(makeInvoice([line]))
    const invoice = await makeProvider().getInvoice('in_123')
    return invoice?.lines[0]?.type
  }

  it('mapeia linha de subscription', async () => {
    expect(await getLineType(makeLine())).toBe('subscription')
  })

  it('mapeia linha de invoiceitem como cobrança pontual', async () => {
    expect(await getLineType(makeLine({ type: 'invoiceitem' }))).toBe('charge')
  })

  it('mapeia proration de invoiceitem', async () => {
    expect(await getLineType(makeLine({ type: 'invoiceitem', proration: true }))).toBe('proration')
  })

  it('mapeia proration de subscription', async () => {
    expect(await getLineType(makeLine({ type: 'subscription', proration: true }))).toBe('proration')
  })

  it('não converte imposto em crédito', async () => {
    expect(await getLineType(makeLine({ type: 'tax' }))).toBe('tax')
  })

  it('não converte desconto em crédito', async () => {
    expect(await getLineType(makeLine({ type: 'discount' }))).toBe('discount')
  })

  it('rejeita tipo desconhecido com erro rastreável', async () => {
    stripeMock.retrieveInvoice.mockResolvedValue(makeInvoice([makeLine({ type: 'mystery' })]))

    await expect(makeProvider().getInvoice('in_123')).rejects.toThrow(
      'Unsupported Stripe invoice line type: mystery',
    )
  })

  it('preserva valores, quantidade, descrição, período e preço', async () => {
    stripeMock.retrieveInvoice.mockResolvedValue(makeInvoice([makeLine({ amount: 1_234, quantity: 3 })]))

    const invoice = await makeProvider().getInvoice('in_123')

    expect(invoice?.lines[0]).toEqual({
      id: 'il_123',
      priceId: 'price_123',
      quantity: 3,
      amountMicros: 12_340_000,
      description: 'Linha de teste',
      type: 'subscription',
      periodStart: new Date(1_700_000_000 * 1000),
      periodEnd: new Date(1_702_592_000 * 1000),
    })
  })
})

const makePaymentIntent = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'pi_123',
    object: 'payment_intent',
    customer: 'cus_123',
    invoice: 'in_123',
    status: 'succeeded',
    amount: 2_000,
    currency: 'brl',
    payment_method_types: ['card'],
    latest_charge: null,
    metadata: {},
    ...overrides,
  }) as unknown as Stripe.PaymentIntent

describe('StripeProvider.getPayment / mapPayment', () => {
  const CHARGE_CREATED_AT = new Date(1_700_500_000 * 1000)

  const makeExpandedCharge = (overrides: Record<string, unknown> = {}) => ({
    id: 'ch_123',
    created: 1_700_500_000,
    receipt_url: 'https://receipt.stripe.com/invoice/123',
    balance_transaction: {
      id: 'txn_123',
      fee: 150,
    } as unknown as Stripe.BalanceTransaction,
    ...overrides,
  })

  it('solicita expansão de latest_charge e balance_transaction no retrieve', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(makePaymentIntent())

    await makeProvider().getPayment('pi_123')

    expect(stripeMock.retrievePaymentIntent).toHaveBeenCalledWith('pi_123', {
      expand: ['latest_charge', 'latest_charge.balance_transaction'],
    })
  })

  it('mapeia pagamento com latest_charge expandido (fee, recibo e paidAt do charge)', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(
      makePaymentIntent({ latest_charge: makeExpandedCharge() }),
    )

    const payment = await makeProvider().getPayment('pi_123')

    expect(payment).toMatchObject({
      id: 'pi_123',
      invoiceId: 'in_123',
      customerId: 'cus_123',
      amountMicros: 20_000_000,
      currency: 'BRL',
      status: 'succeeded',
      paymentMethodType: 'card',
      providerFeeMicros: 1_500_000,
      receiptUrl: 'https://receipt.stripe.com/invoice/123',
    })
    expect(payment?.paidAt).toEqual(CHARGE_CREATED_AT)
  })

  it('fee fica indefinida (não zero) quando balance_transaction não veio expandido', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(
      makePaymentIntent({
        latest_charge: makeExpandedCharge({ balance_transaction: 'txn_123' }),
      }),
    )

    const payment = await makeProvider().getPayment('pi_123')

    expect(payment?.providerFeeMicros).toBeUndefined()
    expect(payment?.receiptUrl).toBe('https://receipt.stripe.com/invoice/123')
  })

  it('mapeia pagamento sem latest_charge expandido (sem fee nem recibo)', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(makePaymentIntent({ latest_charge: null }))

    const payment = await makeProvider().getPayment('pi_123')

    expect(payment?.providerFeeMicros).toBeUndefined()
    expect(payment?.receiptUrl).toBeUndefined()
    // Sem charge expandido não há fonte confiável para a data do pagamento.
    expect(payment?.paidAt).toBeUndefined()
    expect(payment?.status).toBe('succeeded')
  })

  it('mapeia latest_charge como string (ID, não objeto)', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(makePaymentIntent({ latest_charge: 'ch_123' }))

    const payment = await makeProvider().getPayment('pi_123')

    expect(payment?.providerFeeMicros).toBeUndefined()
    expect(payment?.receiptUrl).toBeUndefined()
    expect(payment?.paidAt).toBeUndefined()
  })

  it('mapeia payment_intent falhado como failed', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(makePaymentIntent({ status: 'failed' }))

    const payment = await makeProvider().getPayment('pi_123')

    expect(payment?.status).toBe('failed')
  })

  it('mapeia payment_intent processing como pending', async () => {
    stripeMock.retrievePaymentIntent.mockResolvedValue(makePaymentIntent({ status: 'processing' }))

    const payment = await makeProvider().getPayment('pi_123')

    expect(payment?.status).toBe('pending')
  })
})

describe('StripeProvider.createPrice', () => {
  it('envia trial_period_days dentro de recurring', async () => {
    stripeMock.createPrice.mockResolvedValue({
      id: 'price_new',
      product: 'prod_123',
      currency: 'brl',
      unit_amount: 5_000,
      recurring: {
        interval: 'month',
        interval_count: 1,
        trial_period_days: 14,
        usage_type: 'licensed',
      },
      metadata: {},
      active: true,
    })

    await makeProvider().createPrice('prod_123', {
      currency: 'BRL',
      unitAmountMicros: 50_000_000,
      interval: 'month',
      intervalCount: 1,
      trialPeriodDays: 14,
      usageType: 'licensed',
    })

    expect(stripeMock.createPrice).toHaveBeenCalledWith(
      {
        product: 'prod_123',
        currency: 'brl',
        unit_amount: 5_000,
        recurring: {
          interval: 'month',
          interval_count: 1,
          trial_period_days: 14,
          usage_type: 'licensed',
        },
        metadata: undefined,
      },
      { idempotencyKey: undefined },
    )
  })
})

describe('StripeProvider.createCreditNote', () => {
  const provider = makeProvider()

  it('mantém motivo mapeado (duplicate)', async () => {
    stripeMock.createCreditNote.mockResolvedValue({
      id: 'cn_123',
      customer: 'cus_123',
      invoice: 'in_123',
      amount: 500,
      currency: 'brl',
      reason: 'duplicate',
      memo: null,
      status: 'issued',
      created: 1_700_000_000,
    })

    const cn = await provider.createCreditNote({
      invoiceId: 'in_123',
      amountMicros: 5_000_000,
      reason: 'duplicate',
    })

    expect(stripeMock.createCreditNote).toHaveBeenCalledWith(
      { invoice: 'in_123', amount: 500, reason: 'duplicate', memo: undefined },
      { idempotencyKey: undefined },
    )
    expect(cn.reason).toBe('duplicate')
  })

  it('não converte other em duplicate: omite o campo reason e preserva o motivo no memo', async () => {
    stripeMock.createCreditNote.mockResolvedValue({
      id: 'cn_124',
      customer: 'cus_123',
      invoice: 'in_123',
      amount: 500,
      currency: 'brl',
      reason: null,
      memo: '[reason: other] Reembolso por acordo',
      status: 'issued',
      created: 1_700_000_000,
    })

    const cn = await provider.createCreditNote({
      invoiceId: 'in_123',
      amountMicros: 5_000_000,
      reason: 'other',
      memo: 'Reembolso por acordo',
    })

    expect(stripeMock.createCreditNote).toHaveBeenCalledWith(
      { invoice: 'in_123', amount: 500, reason: undefined, memo: '[reason: other] Reembolso por acordo' },
      { idempotencyKey: undefined },
    )
    // Sem rotulagem falsa: a Stripe registra sem motivo (null), nunca 'duplicate'.
    expect(cn.reason).toBeNull()
  })

  it('other sem memo: o motivo ainda chega ao memo', async () => {
    stripeMock.createCreditNote.mockResolvedValue({
      id: 'cn_125',
      customer: 'cus_123',
      invoice: 'in_123',
      amount: 500,
      currency: 'brl',
      reason: null,
      memo: '[reason: other]',
      status: 'issued',
      created: 1_700_000_000,
    })

    await provider.createCreditNote({
      invoiceId: 'in_123',
      amountMicros: 5_000_000,
      reason: 'other',
    })

    expect(stripeMock.createCreditNote).toHaveBeenCalledWith(
      { invoice: 'in_123', amount: 500, reason: undefined, memo: '[reason: other]' },
      { idempotencyKey: undefined },
    )
  })

  it('other com memo que já anota o motivo: não duplica a anotação', async () => {
    stripeMock.createCreditNote.mockResolvedValue({
      id: 'cn_126',
      customer: 'cus_123',
      invoice: 'in_123',
      amount: 500,
      currency: 'brl',
      reason: null,
      memo: '[reason: other] Reembolso por acordo',
      status: 'issued',
      created: 1_700_000_000,
    })

    await provider.createCreditNote({
      invoiceId: 'in_123',
      amountMicros: 5_000_000,
      reason: 'other',
      memo: '[reason: other] Reembolso por acordo',
    })

    expect(stripeMock.createCreditNote).toHaveBeenCalledWith(
      { invoice: 'in_123', amount: 500, reason: undefined, memo: '[reason: other] Reembolso por acordo' },
      { idempotencyKey: undefined },
    )
  })
})

describe('StripeProvider.parseWebhookEvent', () => {
  const provider = makeProvider()

  it('normaliza evento de subscription pausada como atualização', () => {
    const normalized = provider.parseWebhookEvent(
      makeWebhookEvent('customer.subscription.paused', {
        id: 'sub_123',
        customer: 'cus_123',
      }),
    )

    expect(normalized).toMatchObject({
      type: 'subscription.updated',
      providerName: 'stripe',
      providerEventId: 'evt_123',
      providerSubscriptionId: 'sub_123',
      providerCustomerId: 'cus_123',
      providerInvoiceId: undefined,
    })
  })

  it('normaliza evento de subscription retomada como atualização', () => {
    const normalized = provider.parseWebhookEvent(
      makeWebhookEvent('customer.subscription.resumed', {
        id: 'sub_123',
        customer: 'cus_123',
      }),
    )

    expect(normalized.type).toBe('subscription.updated')
  })

  it('extrai subscription, customer, invoice e payment de invoice.paid', () => {
    const normalized = provider.parseWebhookEvent(
      makeWebhookEvent('invoice.paid', {
        id: 'in_123',
        customer: 'cus_123',
        subscription: 'sub_123',
        payment_intent: 'pi_123',
      }),
    )

    expect(normalized).toMatchObject({
      type: 'invoice.paid',
      providerSubscriptionId: 'sub_123',
      providerCustomerId: 'cus_123',
      providerInvoiceId: 'in_123',
      providerPaymentId: 'pi_123',
    })
  })

  it('extrai IDs de objetos expandidos', () => {
    const normalized = provider.parseWebhookEvent(
      makeWebhookEvent('invoice.paid', {
        id: 'in_123',
        customer: { id: 'cus_123' },
        subscription: { id: 'sub_123' },
        payment_intent: { id: 'pi_123' },
      }),
    )

    expect(normalized).toMatchObject({
      providerSubscriptionId: 'sub_123',
      providerCustomerId: 'cus_123',
      providerPaymentId: 'pi_123',
    })
  })

  it('usa data.id como payment id em eventos de payment_intent', () => {
    const normalized = provider.parseWebhookEvent(
      makeWebhookEvent('payment_intent.succeeded', {
        id: 'pi_123',
        customer: 'cus_123',
      }),
    )

    expect(normalized).toMatchObject({
      type: 'payment_intent.succeeded',
      providerPaymentId: 'pi_123',
      providerCustomerId: 'cus_123',
    })
  })
})
