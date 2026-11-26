/**
 * Billing Plan Service — Camada de domínio para gestão de planos.
 *
 * Encapsula regras de negócio: criação, atualização, precificação.
 * Usa ProviderRegistry para delegar chamadas ao provider concreto (Stripe, etc.).
 */

import type { ProviderRegistry } from './provider-registry.js'
import type { BillingProvider, ProviderPrice, PlanFeatures, PlanPricing } from './provider.js'
import type { Db, DbTx } from '@comprova/db'
import { billingPlan } from '@comprova/db'
import { eq, desc } from '@comprova/db'
import { randomUUID } from 'node:crypto'

export interface CreatePlanInput {
  readonly name: string
  readonly description?: string
  readonly providerName: string
  readonly monthlyPriceMicros: number
  readonly interval?: 'month' | 'year'
  readonly intervalCount?: number
  readonly features: PlanFeatures
  readonly createdByAdminId: string
  readonly idempotencyKey?: string
}

export interface UpdatePlanInput {
  readonly name?: string
  readonly description?: string
  readonly monthlyPriceMicros?: number
  readonly interval?: 'month' | 'year'
  readonly intervalCount?: number
  readonly features?: Partial<PlanFeatures>
  readonly isActive?: boolean
  readonly idempotencyKey?: string
}

export class BillingPlanService {
  constructor(
    private readonly db: Db,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Cria um novo plano e sincroniza com o provider (Product + Price).
   */
  async createPlan(input: CreatePlanInput, tx?: DbTx): Promise<typeof billingPlan.$inferSelect> {
    const db = tx ?? this.db
    const provider = this.providerRegistry.get(input.providerName)

    // 1. Cria Product no provider
    const product = await provider.createProduct({
      name: input.name,
      description: input.description,
      metadata: { comprova_plan_name: input.name },
      idempotencyKey: input.idempotencyKey ?? `plan-product-${input.name}`,
    })

    // 2. Cria Price no provider
    const price = await provider.createPrice(product.id, {
      currency: input.features.currency,
      unitAmountMicros: input.monthlyPriceMicros,
      interval: input.interval ?? 'month',
      intervalCount: input.intervalCount ?? 1,
      trialPeriodDays: input.features.trialDays,
      usageType: 'licensed',
      metadata: { comprova_plan_name: input.name },
      idempotencyKey: input.idempotencyKey ?? `plan-price-${input.name}`,
    })

    // 3. Salva plano local com IDs do provider
    const planId = randomUUID()
    const [plan] = await db
      .insert(billingPlan)
      .values({
        id: planId,
        name: input.name,
        description: input.description,
        providerName: input.providerName,
        providerProductId: product.id,
        providerPriceId: price.id,
        interval: input.interval ?? 'month',
        intervalCount: input.intervalCount ?? 1,
        trialPeriodDays: input.features.trialDays ?? 0,
        features: input.features,
        monthlyPriceMicros: input.monthlyPriceMicros,
        isActive: true,
        createdByAdminId: input.createdByAdminId,
      })
      .returning()

    if (!plan) {
      throw new Error('Failed to create billing plan')
    }

    return plan
  }

  /**
   * Atualiza um plano. Se preço/intervalo mudam, cria novo Price e arquiva o antigo.
   */
  async updatePlan(planId: string, input: UpdatePlanInput, tx?: DbTx): Promise<typeof billingPlan.$inferSelect> {
    const db = tx ?? this.db

    const plan = await this.getPlan(planId, db)
    const provider = this.providerRegistry.get(plan.providerName)

    const updateData: Partial<typeof billingPlan.$inferInsert> = {}

    // Atualiza Product se nome/descrição mudaram
    if (input.name || input.description) {
      await provider.updateProduct(plan.providerProductId, {
        name: input.name,
        description: input.description,
        idempotencyKey: `plan-product-${planId}-update`,
      })
      if (input.name) updateData.name = input.name
      if (input.description !== undefined) updateData.description = input.description
    }

    // Se preço ou intervalo mudaram, cria NOVO price (Stripe não permite alterar price existente)
    const priceChanged = input.monthlyPriceMicros !== undefined && input.monthlyPriceMicros !== plan.monthlyPriceMicros
    const intervalChanged = input.interval !== undefined && input.interval !== plan.interval
    const intervalCountChanged = input.intervalCount !== undefined && input.intervalCount !== plan.intervalCount

    if (priceChanged || intervalChanged || intervalCountChanged) {
      const newPrice = await provider.createPrice(plan.providerProductId, {
        currency: plan.features.currency,
        unitAmountMicros: input.monthlyPriceMicros ?? plan.monthlyPriceMicros,
        interval: input.interval ?? plan.interval,
        intervalCount: input.intervalCount ?? plan.intervalCount,
        trialPeriodDays: plan.trialPeriodDays,
        usageType: 'licensed',
        metadata: { comprova_plan_id: planId, comprova_plan_name: plan.name },
        idempotencyKey: `plan-price-${planId}-${Date.now()}`,
      })

      // Arquiva o price antigo no provider
      await provider.archiveProduct(plan.providerPriceId)

      updateData.providerPriceId = newPrice.id
      if (input.monthlyPriceMicros !== undefined) updateData.monthlyPriceMicros = input.monthlyPriceMicros
      if (input.interval !== undefined) updateData.interval = input.interval
      if (input.intervalCount !== undefined) updateData.intervalCount = input.intervalCount
    }

    // Atualiza features se fornecido
    if (input.features) {
      updateData.features = { ...plan.features, ...input.features }
    }

    if (input.isActive !== undefined) {
      updateData.isActive = input.isActive
      // Se desativando, arquiva price no provider
      if (!input.isActive) {
        await provider.archiveProduct(plan.providerPriceId)
      }
    }

    const [updated] = await db
      .update(billingPlan)
      .set(updateData)
      .where(eq(billingPlan.id, planId))
      .returning()

    if (!updated) {
      throw new Error('Failed to update billing plan')
    }

    return updated
  }

  /**
   * Arquiva (soft delete) um plano.
   */
  async archivePlan(planId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db
    const plan = await this.getPlan(planId, db)
    const provider = this.providerRegistry.get(plan.providerName)

    await provider.archiveProduct(plan.providerPriceId)

    await db
      .update(billingPlan)
      .set({ isActive: false })
      .where(eq(billingPlan.id, planId))
  }

  /**
   * Busca plano por ID.
   */
  async getPlan(planId: string, db?: Db | DbTx): Promise<typeof billingPlan.$inferSelect> {
    const client = db ?? this.db
    const [plan] = await client
      .select()
      .from(billingPlan)
      .where(eq(billingPlan.id, planId))
      .limit(1)

    if (!plan) {
      throw new Error(`Billing plan not found: ${planId}`)
    }

    return plan
  }

  /**
   * Busca plano por provider_price_id.
   */
  async getPlanByProviderPriceId(providerPriceId: string, db?: Db | DbTx): Promise<typeof billingPlan.$inferSelect> {
    const client = db ?? this.db
    const [plan] = await client
      .select()
      .from(billingPlan)
      .where(eq(billingPlan.providerPriceId, providerPriceId))
      .limit(1)

    if (!plan) {
      throw new Error(`Billing plan not found for provider price: ${providerPriceId}`)
    }

    return plan
  }

  /**
   * Lista planos ativos (público para verifiers verem opções).
   */
  async listActivePlans(db?: Db | DbTx): Promise<ReadonlyArray<typeof billingPlan.$inferSelect>> {
    const client = db ?? this.db
    return client
      .select()
      .from(billingPlan)
      .where(eq(billingPlan.isActive, true))
      .orderBy(desc(billingPlan.createdAt))
  }

  /**
   * Lista todos os planos (admin).
   */
  async listAllPlans(db?: Db | DbTx): Promise<ReadonlyArray<typeof billingPlan.$inferSelect>> {
    const client = db ?? this.db
    return client
      .select()
      .from(billingPlan)
      .orderBy(desc(billingPlan.createdAt))
  }

  /**
   * Obtém precificação derivada do plano para uso no fastpath.
   */
  async getPlanPricing(planId: string, db?: Db | DbTx): Promise<PlanPricing> {
    const plan = await this.getPlan(planId, db)
    return {
      amountMicros: plan.monthlyPriceMicros / plan.features.validationsIncluded,
      debitMode: plan.features.debitMode ?? 'grace',
      validationsIncluded: plan.features.validationsIncluded,
      overagePriceMicros: plan.features.overagePriceMicros,
      currency: plan.features.currency,
      providerPriceId: plan.providerPriceId,
      usageType: 'metered',
    }
  }
}