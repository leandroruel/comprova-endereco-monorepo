/**
 * Invoice Service — Gerencia faturas e pagamentos.
 *
 * Sincroniza invoices do provider, processa pagamentos,
 * e expõe consultas para dashboard/admin.
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { Db, DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { eq, and, desc } from '@comprova/db'
import { randomUUID } from 'node:crypto'
import { CustomerService } from './customer.service.js'

export interface InvoiceWithDetails {
  readonly invoice: t.Invoice
  readonly payments: ReadonlyArray<t.Payment>
  readonly subscription?: t.TenantSubscription
}

export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly providerRegistry: ProviderRegistry,
    private readonly customerService: CustomerService,
  ) {}

  /**
   * Resolve o tenant local a partir do customer do provider ou lança erro.
   */
  private async requireTenantId(customerId: string, db: Db | DbTx): Promise<string> {
    const tenant = await this.customerService.getTenantByProviderCustomerId(customerId, db)

    if (!tenant) {
      throw new Error(`Tenant not found for provider customer ${customerId}`)
    }
    return tenant.tenantId
  }

  /**
   * Sincroniza invoice do provider para o banco local.
   * Chamado pelo webhook handler quando invoice.paid/finalized.
   */
  async syncInvoice(
    providerInvoiceId: string,
    providerName: string,
    tx?: Db | DbTx,
  ): Promise<t.Invoice | null> {
    const db = tx ?? this.db
    const provider = this.providerRegistry.get(providerName)

    const providerInvoice = await provider.getInvoice(providerInvoiceId)
    if (!providerInvoice) {
      return null
    }

    const localSubscriptionId = providerInvoice.subscriptionId
      ? await this.findSubscriptionIdByProviderId(providerInvoice.subscriptionId, db)
      : null
    const tenantId = await this.requireTenantId(providerInvoice.customerId, db)
    // Linhas do provider persistidas em `items` (JSONB) para relatórios.
    const lines = providerInvoice.lines

    const [synced] = await db
      .insert(t.invoice)
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
        tenantId,
        number: providerInvoice.id, // Use provider invoice ID as number
        items: lines,
      })
      .onConflictDoUpdate({
        target: t.invoice.providerInvoiceId,
        set: {
          status: providerInvoice.status,
          amountDueMicros: providerInvoice.amountDueMicros,
          amountPaidMicros: providerInvoice.amountPaidMicros,
          hostedInvoiceUrl: providerInvoice.hostedInvoiceUrl,
          invoicePdfUrl: providerInvoice.invoicePdfUrl,
          dueDate: providerInvoice.dueDate,
          paidAt: providerInvoice.paidAt,
          metadata: providerInvoice.metadata,
          items: lines,
        },
      })
      .returning()

    return synced ?? null
  }

  /**
   * Busca o id local de uma subscription a partir do id no provider.
   */
  private async findSubscriptionIdByProviderId(
    providerSubscriptionId: string,
    db: Db | DbTx,
  ): Promise<string | null> {
    const [sub] = await db
      .select({ id: t.tenantSubscription.id })
      .from(t.tenantSubscription)
      .where(eq(t.tenantSubscription.providerSubscriptionId, providerSubscriptionId))
      .limit(1)

    return sub?.id ?? null
  }

  /**
   * Sincroniza payment do provider.
   */
  async syncPayment(
    providerPaymentId: string,
    providerName: string,
    tx?: Db | DbTx,
  ): Promise<t.Payment | null> {
    const db = tx ?? this.db
    const provider = this.providerRegistry.get(providerName)

    const providerPayment = await provider.getPayment(providerPaymentId)
    if (!providerPayment) {
      return null
    }

    const localInvoiceId = providerPayment.invoiceId
      ? await this.findInvoiceIdByProviderId(providerPayment.invoiceId, db)
      : null
    const tenantId = await this.requireTenantId(providerPayment.customerId, db)

    const [synced] = await db
      .insert(t.payment)
      .values({
        id: randomUUID(),
        invoiceId: localInvoiceId,
        providerName,
        providerPaymentId: providerPayment.id,
        status: providerPayment.status,
        amountMicros: providerPayment.amountMicros,
        currency: providerPayment.currency,
        paymentMethodType: providerPayment.paymentMethodType,
        providerFeeMicros: providerPayment.providerFeeMicros,
        receiptUrl: providerPayment.receiptUrl,
        paidAt: providerPayment.paidAt,
        refundedAt: providerPayment.refundedAt,
        metadata: providerPayment.metadata,
        tenantId,
        provider: providerName,
      })
      .onConflictDoUpdate({
        target: t.payment.providerPaymentId,
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
   * Busca o id local de uma invoice a partir do id no provider.
   */
  private async findInvoiceIdByProviderId(providerInvoiceId: string, db: Db | DbTx): Promise<string | null> {
    const [inv] = await db
      .select({ id: t.invoice.id })
      .from(t.invoice)
      .where(eq(t.invoice.providerInvoiceId, providerInvoiceId))
      .limit(1)

    return inv?.id ?? null
  }

  /**
   * Lista invoices do tenant (para dashboard).
   */
  async listInvoicesByTenant(
    tenantId: string,
    options?: { readonly limit?: number; readonly status?: string },
    tx?: DbTx,
  ): Promise<ReadonlyArray<t.Invoice>> {
    const db = tx ?? this.db

    return db
      .select({ invoice: t.invoice })
      .from(t.invoice)
      .where(eq(t.invoice.tenantId, tenantId))
      .orderBy(desc(t.invoice.createdAt))
      .limit(options?.limit ?? 50)
      .then((rows: ReadonlyArray<{ invoice: t.Invoice }>) => rows.map((r) => r.invoice))
  }

  /**
   * Busca invoice por ID local.
   */
  async getInvoice(invoiceId: string, tx?: DbTx): Promise<InvoiceWithDetails | null> {
    const db = tx ?? this.db

    const [inv] = await db.select().from(t.invoice).where(eq(t.invoice.id, invoiceId)).limit(1)

    if (!inv) return null

    const payments = await db
      .select()
      .from(t.payment)
      .where(eq(t.payment.invoiceId, invoiceId))
      .orderBy(desc(t.payment.createdAt))

    const [subscription] = inv.subscriptionId
      ? await db
          .select()
          .from(t.tenantSubscription)
          .where(eq(t.tenantSubscription.id, inv.subscriptionId))
          .limit(1)
      : []

    return { invoice: inv, payments, subscription }
  }

  /**
   * Busca invoice por provider_invoice_id.
   */
  async getInvoiceByProviderId(
    providerInvoiceId: string,
    providerName: string,
    tx?: DbTx,
  ): Promise<t.Invoice | null> {
    const db = tx ?? this.db

    const [inv] = await db
      .select()
      .from(t.invoice)
      .where(
        and(eq(t.invoice.providerInvoiceId, providerInvoiceId), eq(t.invoice.providerName, providerName)),
      )
      .limit(1)

    return inv ?? null
  }

  /**
   * Obtém resumo de faturamento do tenant (para dashboard).
   */
  async getBillingSummary(
    tenantId: string,
    tx?: DbTx,
  ): Promise<{
    readonly totalInvoicedMicros: number
    readonly totalPaidMicros: number
    readonly totalPendingMicros: number
    readonly openInvoicesCount: number
    readonly overdueInvoicesCount: number
  }> {
    const db = tx ?? this.db

    const invoices = await db.select().from(t.invoice).where(eq(t.invoice.tenantId, tenantId))
    const now = new Date()

    const summary = invoices.reduce(
      (acc, inv) => ({
        totalInvoicedMicros: acc.totalInvoicedMicros + (inv.amountDueMicros ?? 0),
        totalPaidMicros: acc.totalPaidMicros + (inv.amountPaidMicros ?? 0),
        openInvoicesCount: acc.openInvoicesCount + (inv.status === 'open' ? 1 : 0),
        overdueInvoicesCount:
          acc.overdueInvoicesCount +
          (inv.status === 'open' && inv.dueDate !== null && inv.dueDate < now ? 1 : 0),
      }),
      { totalInvoicedMicros: 0, totalPaidMicros: 0, openInvoicesCount: 0, overdueInvoicesCount: 0 },
    )

    return {
      ...summary,
      totalPendingMicros: summary.totalInvoicedMicros - summary.totalPaidMicros,
    }
  }
}
