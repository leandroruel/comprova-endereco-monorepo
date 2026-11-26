import { sql } from 'drizzle-orm'
import type { DbTx } from './client.js'

/** Resultado de uma operação de débito na wallet. */
export interface WalletDebitResult {
  readonly entryId: number
  readonly availableBalanceMicros: number
  readonly reservedBalanceMicros: number
}

/**
 * Resultado de uma tentativa de débito por conclusão de validação.
 *
 * O débito é contábil e best-effort: a validação já foi concluída quando ele
 * roda, então uma wallet ausente ou saldo insuficiente NÃO pode abortar a
 * transação (o que devolveria 500 e deixaria a validação persistida sem
 * resposta). Nesses casos o uso continua registrado em `usage_billing_unit`
 * para cobrança posterior; o ledger nunca fica negativo.
 */
export type WalletDebitOutcome =
  | ({ readonly status: 'debited' } & WalletDebitResult)
  | { readonly status: 'replayed' }
  | { readonly status: 'skipped'; readonly reason: 'no_wallet' | 'insufficient_balance' }

/** Resultado de uma operação de crédito na wallet. */
export interface WalletCreditResult {
  readonly entryId: number
  readonly availableBalanceMicros: number
  readonly reservedBalanceMicros: number
}

/**
 * Débita a wallet do tenant. Chama a função SQL `wallet_debit` que:
 * - Adquire lock na wallet (ROW EXCLUSIVE)
 * - Verifica idempotência pela `idempotency_key`
 * - Verifica saldo suficiente
 * - Atualiza saldo disponível
 * - Insere entrada no ledger
 * - Retorna o saldo após a operação
 *
 * @param tx Transação já com contexto de tenant (`withTenant`)
 * @param amountMicros Valor em micros (sempre positivo)
 * @param validationId ID da validação que originou o débito
 * @param idempotencyKey Chave de idempotência (canônica: `validation:<validationId>`)
 * @returns Resultado discriminado: debitado, replay idempotente ou ignorado
 */
export const debitWalletForValidation = async (
  tx: DbTx,
  amountMicros: number,
  validationId: string,
  idempotencyKey: string,
): Promise<WalletDebitOutcome> => {
  if (amountMicros <= 0) {
    throw new Error('amountMicros must be positive')
  }

  // Idempotência primeiro: um replay não deve ser barrado por saldo (o saldo já
  // reflete o débito original) nem por wallet ausente.
  const existing = await tx.execute(sql`
    SELECT 1
    FROM wallet_ledger
    WHERE tenant_id = app_tenant_id()
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `)
  if (existing.length > 0) {
    return { status: 'replayed' }
  }

  // Trava a linha da wallet antes de decidir. Isso serializa débitos
  // concorrentes e garante que o saldo lido seja o saldo debitado.
  const walletRows = await tx.execute(sql`
    SELECT available_balance
    FROM wallet
    WHERE tenant_id = app_tenant_id()
    FOR UPDATE
  `)
  const wallet = walletRows[0] as { available_balance: number | string } | undefined
  if (wallet === undefined) {
    return { status: 'skipped', reason: 'no_wallet' }
  }
  if (Number(wallet.available_balance) < amountMicros) {
    return { status: 'skipped', reason: 'insufficient_balance' }
  }

  const rows = await tx.execute(sql`
    SELECT *
    FROM wallet_debit(
      app_tenant_id(),
      ${amountMicros}::bigint,
      'validation'::text,
      ${validationId}::uuid,
      'system'::text,
      'validation completed'::text,
      ${idempotencyKey}::text,
      '{}'::jsonb
    )
  `)

  const row = rows[0] as
    | { entry_id: number; available_balance_micros: number; reserved_balance_micros: number }
    | undefined

  if (!row) {
    // Corrida perdida para outra transação com a mesma chave: replay.
    return { status: 'replayed' }
  }

  return {
    status: 'debited',
    entryId: Number(row.entry_id),
    availableBalanceMicros: Number(row.available_balance_micros),
    reservedBalanceMicros: Number(row.reserved_balance_micros),
  }
}

/**
 * Credita a wallet do tenant. Chama a função SQL `wallet_credit`.
 *
 * @param tx Transação já com contexto de tenant (`withTenant`)
 * @param amountMicros Valor em micros (sempre positivo)
 * @param referenceType Tipo de referência (ex: 'payment', 'adjustment')
 * @param referenceId ID da referência
 * @param actor Quem realizou a operação
 * @param reason Justificativa
 * @param idempotencyKey Chave de idempotência
 * @returns Saldo após crédito ou null se replay (idempotência)
 */
export const creditWallet = async (
  tx: DbTx,
  amountMicros: number,
  referenceType: string,
  referenceId: string,
  actor: string,
  reason: string,
  idempotencyKey: string,
): Promise<WalletCreditResult | null> => {
  if (amountMicros <= 0) {
    throw new Error('amountMicros must be positive')
  }

  const rows = await tx.execute(sql`
    SELECT *
    FROM wallet_credit(
      app_tenant_id(),
      ${amountMicros}::bigint,
      ${referenceType}::text,
      ${referenceId}::uuid,
      ${actor}::text,
      ${reason}::text,
      ${idempotencyKey}::text,
      '{}'::jsonb
    )
  `)

  const row = rows[0] as
    | { entry_id: number; available_balance_micros: number; reserved_balance_micros: number }
    | undefined

  if (!row) {
    return null
  }

  return {
    entryId: Number(row.entry_id),
    availableBalanceMicros: Number(row.available_balance_micros),
    reservedBalanceMicros: Number(row.reserved_balance_micros),
  }
}

/**
 * Obtém o saldo atual da wallet do tenant.
 */
export interface WalletBalance {
  readonly availableBalanceMicros: number
  readonly reservedBalanceMicros: number
  readonly totalBalanceMicros: number
  readonly version: number
  readonly updatedAt: Date
}

export const getWalletBalance = async (tx: DbTx): Promise<WalletBalance | null> => {
  const rows = await tx.execute(sql`
    SELECT available_balance, reserved_balance, (available_balance + reserved_balance) AS total_balance, version, updated_at
    FROM wallet_balance
    WHERE tenant_id = app_tenant_id()
    LIMIT 1
  `)

  const row = rows[0] as
    | { available_balance: number; reserved_balance: number; total_balance: number; version: number; updated_at: Date }
    | undefined

  if (!row) return null

  return {
    availableBalanceMicros: Number(row.available_balance),
    reservedBalanceMicros: Number(row.reserved_balance),
    totalBalanceMicros: Number(row.total_balance),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}