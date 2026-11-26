/**
 * Invoice Service — Gerencia faturas e pagamentos.
 *
 * Sincroniza invoices do provider, processa pagamentos,
 * e expõe consultas para dashboard/admin.
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { BillingProvider, ProviderInvoice, ProviderPayment, ListInvoicesOptions } from './provider.js'
import type { Db, DbTx } from '@comprova/db'
import { invoice, payment, tenantSubscription } from '@comprova/db'
import { eq, and, desc } from '@comprova/db'
import { randomUUID } from 'node:crypto'

export interface InvoiceWithDetails {
  readonly invoice: typeof invoice.$inferSelect
  readonly payments: ReadonlyArray<typeof payment.$inferSelect>
  readonly subscription?: typeof tenantSubscription.$inferSelect
}

export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Sincroniza invoice do provider para o banco local.
   * Chamado pelo webhook handler quando invoice.paid/finalized.
   */
  async syncInvoice(
    providerInvoiceId: string,
    providerName: string,
    tx?: DbTx,
  ): Promise<typeof invoice.$inferSelect | null> {
    const db = tx ?? this.db
    const provider = this.providerRegistry.get(providerName)

    const providerInvoice = await provider.getInvoice(providerInvoiceId)
    if (!providerInvoice) {
      return null
    }

    // Busca subscription local pelo provider_subscription_id
    const subscriptionId = providerInvoice.subscriptionId
    let localSubscriptionId: string | null = null

    if (subscriptionId) {
      const [sub] = await db
        .select({ id: tenantSubscription.id })
        .from(tenantSubscription)
        .where(eq(tenantSubscription.providerSubscriptionId, subscriptionId))
        .limit(1)
      localSubscriptionId = sub?.id ?? null
    }

    const [synced] = await db
      .insert(invoice)
      .values({
        id: randomUUID(),
        subscriptionId: localSubscriptionId,
        providerName,
        providerInvoiceId: providerInvoice.id,
        status: providerInvoice.status,
        amountDueMicros: providerInvoice.amountDueMicros,
        amountPaidMicros: providerInvoice.amountPaidMicros,
        currency: providerInvoice.currency,
        hostedInvoiceUrl: providerInvoice.hostedInvoiceUrl,
        invoicePdfUrl: providerInvoice.invoicePdfUrl,
        periodStart: providerInvoice.periodStart,
        periodEnd: providerInvoice.periodEnd,
        dueDate: providerInvoice.dueDate,
        paidAt: providerInvoice.paidAt,
        metadata: providerInvoice.metadata,
      })
      .onConflictDoUpdate({
        target: invoice.providerInvoiceId,
        set: {
          status: providerInvoice.status,
          amountDueMicros: providerInvoice.amountDueMicros,
          amountPaidMicros: providerInvoice.amountPaidMicros,
          hostedInvoiceUrl: providerInvoice.hostedInvoiceUrl,
          invoicePdfUrl: providerInvoice.invoicePdfUrl,
          dueDate: providerInvoice.dueDate,
          paidAt: providerInvoice.paidAt,
          metadata: providerInvoice.metadata,
        },
      })
      .returning()

    return synced ?? null
  }

  /**
   * Sincroniza payment do provider.
   */
  async syncPayment(
    providerPaymentId: string,
    providerName: string,
    tx?: DbTx,
  ): Promise<typeof payment.$inferSelect | null> {
    const db = tx ?? this.db
    const provider = this.providerRegistry.get(providerName)

    const providerPayment = await provider.getPayment(providerPaymentId)
    if (!providerPayment) {
      return null
    }

    // Busca invoice local se houver
    let localInvoiceId: string | null = null
    if (providerPayment.invoiceId) {
      const [inv] = await db
        .select({ id: invoice.id })
        .from(invoice)
        .where(eq(invoice.providerInvoiceId, providerPayment.invoiceId))
        .limit(1)
      localInvoiceId = inv?.id ?? null
    }

    const [synced] = await db
      .insert(payment)
      .values({
        id: randomUUID(),
        invoiceId: localInvoiceId,
        providerName,
        providerPaymentId: providerPayment.id,
        providerChargeId: providerPayment.providerChargeId,
        status: providerPayment.status,
        amountMicros: providerPayment.amountMicros,
        currency: providerPayment.currency,
        paymentMethodType: providerPayment.paymentMethodType,
        providerFeeMicros: providerPayment.providerFeeMicros,
        receiptUrl: providerPayment.receiptUrl,
        paidAt: providerPayment.paidAt,
        refundedAt: providerPayment.refundedAt,
        metadata: providerPayment.metadata,
      })
      .onConflictDoUpdate({
        target: payment.providerPaymentId,
        set: {
          status: providerPayment.status,
          amountMicros: providerPayment.amountMicros,
          providerFeeMicros: providerPayment.providerFeeMicros,
          receiptUrl: providerPayment.receiptUrl,
          paidAt: providerPayment.paidAt,
          refundedAt: providerPayment.refundedAt,
          metadata: providerPayment.metadata,
        },
      })
      .returning()

    return synced ?? null
  }

  /**
   * Lista invoices do tenant (para dashboard).
   */
  async listInvoicesByTenant(
    tenantId: string,
    options?: { readonly limit?: number; readonly status?: string },
    tx?: DbTx,
  ): Promise<ReadonlyArray<typeof invoice.$inferSelect>> {
    const db = tx ?? this.db

    const subscriptions = await db
      .select({ id: tenantSubscription.id })
      .from(tenantSubscription)
      .where(eq(tenantSubscription.tenantId, tenantId))

    if (subscriptions.length === 0) {
      return []
    }

    return db
      .select({ invoice: invoice })
      .from(invoice)
      .innerJoin(tenantSubscription, eq(invoice.subscriptionId, tenantSubscription.id))
      .where(eq(tenantSubscription.tenantId, tenantId))
      .orderBy(desc(invoice.createdAt))
      .limit(options?.limit ?? 50)
      .then((rows: ReadonlyArray<{ invoice: typeof invoice.$inferSelect }>) => rows.map((r) => r.invoice))
  }

  /**
   * Busca invoice por ID local.
   */
  async getInvoice(invoiceId: string, tx?: DbTx): Promise<InvoiceWithDetails | null> {
    const db = tx ?? this.db

    const [inv] = await db
      .select()
      .from(invoice)
      .where(eq(invoice.id, invoiceId))
      .limit(1)

    if (!inv) return null

    const payments = await db
      .select()
      .from(payment)
      .where(eq(payment.invoiceId, invoiceId))
      .orderBy(desc(payment.createdAt))

    let subscription: typeof tenantSubscription.$inferSelect | undefined
    if (inv.subscriptionId) {
      const [sub] = await db
        .select()
        .from(tenantSubscription)
        .where(eq(tenantSubscription.id, inv.subscriptionId))
        .limit(1)
      subscription = sub
    }

    return { invoice: inv, payments, subscription }
  }

  /**
   * Busca invoice por provider_invoice_id.
   */
  async getInvoiceByProviderId(
    providerInvoiceId: string,
    providerName: string,
    tx?: DbTx,
  ): Promise<typeof invoice.$inferSelect | null> {
    const db = tx ?? this.db

    const [inv] = await db
      .select()
      .from(invoice)
      .where(
        and(
          eq(invoice.providerInvoiceId, providerInvoiceId),
          eq(invoice.providerName, providerName),
        ),
      )
      .limit(1)

    return inv ?? null
  }

  /**
   * Obtém resumo de faturamento do tenant (para dashboard).
   */
  async getBillingSummary(tenantId: string, tx?: DbTx): Promise<{
    readonly totalInvoicedMicros: number
    readonly totalPaidMicros: number
    readonly totalPendingMicros: number
    readonly openInvoicesCount: number
    readonly overdueInvoicesCount: number
  }> {
    const db = tx ?? this.db

    const subscriptions = await db
      .select({ id: tenantSubscription.id })
      .from(tenantSubscription)
      .where(eq(tenantSubscription.tenantId, tenantId))

    if (subscriptions.length === 0) {
      return {
        totalInvoicedMicros: 0,
        totalPaidMicros: 0,
        totalPendingMicros: 0,
        openInvoicesCount: 0,
        overdueInvoicesCount: 0,
      }
    }

    const invoices = await db
      .select()
      .from(invoice)
      .where(eq(invoice.subscriptionId, subscriptions[0].id))

    let totalInvoicedMicros = 0
    let totalPaidMicros = 0
    let openInvoicesCount = 0
    let overdueInvoicesCount = 0

    for (const inv of invoices) {
      totalInvoicedMicros += inv.amountDueMicros
      totalPaidMicros += inv.amountPaidMicros

      if (inv.status === 'open') {
        openInvoicesCount++
        if (inv.dueDate && inv.dueDate < new Date()) {
          overdueInvoicesCount++
        }
      }
    }

    return {
      totalInvoicedMicros,
      totalPaidMicros,
      totalPendingMicros: totalInvoicedMicros - totalPaidMicros,
      openInvoicesCount,
      overdueInvoicesCount,
    }
  }
}