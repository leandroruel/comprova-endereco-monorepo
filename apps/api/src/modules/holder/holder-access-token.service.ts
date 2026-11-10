import { and, count, eq, isNull, sql, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { HolderInformationRequestState } from '@comprova/contracts'
import type { Logger } from '@comprova/observability'
import { randomUUID } from 'node:crypto'
import {
  expireIfNeeded,
  insertHolderInformationRequestEvent,
  lockRequestById,
} from './holder-information-request.shared.js'
import { hashHolderAccessToken, holderTokenPrefixOf, newHolderAccessToken } from './holder-token.js'

/** Máximo de tokens efetivamente utilizáveis por solicitação. */
export const HOLDER_ACCESS_TOKEN_MAX_ACTIVE = 5
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TOKEN_TTL_CEILING_MS = 30 * 24 * 60 * 60 * 1000

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

const errorCodeOf = (error: unknown, depth = 0): string | null => {
  if (depth > 3 || typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return errorCodeOf((error as { cause?: unknown }).cause, depth + 1)
}

export type IssueHolderAccessTokenResult =
  | {
      readonly kind: 'created'
      readonly tokenId: string
      readonly token: string
      readonly expiresAt: Date
      readonly createdAt: Date
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'state'; readonly state: HolderInformationRequestState }
  | { readonly kind: 'expired' }
  | { readonly kind: 'limit' }

export type RevokeHolderAccessTokenResult = { readonly kind: 'revoked' } | { readonly kind: 'not_found' }

/**
 * Emissão e revogação de tokens do Holder.
 *
 * A emissão adquire o lock da solicitação antes de contar tokens ativos e
 * inserir a nova linha: duas emissões concorrentes não ultrapassam o limite, e
 * uma emissão concorrente com cancelamento/expiração nunca cria um token
 * depois do estado terminal. Ordem de locks: solicitação → token.
 */
export const makeHolderAccessTokenService = (deps: {
  readonly db: Db
  readonly pepper: string
  readonly logger: Logger
}) => {
  const { db, pepper, logger } = deps

  const logError = (operation: string, tenantId: string, error: unknown): void => {
    logger.error(
      {
        tenant_id: tenantId,
        operation,
        error_name: errorNameOf(error),
        error_code: errorCodeOf(error),
      },
      'holder access token operation failed',
    )
  }

  const issueToken = async (
    actor: string,
    tenantId: string,
    requestId: string,
  ): Promise<IssueHolderAccessTokenResult> => {
    // Gerado fora da transação; nada é persistido sem o lock da solicitação.
    const token = newHolderAccessToken()
    const tokenPrefix = holderTokenPrefixOf(token)
    const tokenHash = hashHolderAccessToken(token, pepper)

    return withTenant(db, tenantId, async (tx) => {
      const request = await lockRequestById(tx, tenantId, requestId)

      if (!request) return { kind: 'not_found' } as const

      const state = request.state as HolderInformationRequestState

      if (state !== 'pending' && state !== 'in_progress') {
        return { kind: 'state', state } as const
      }

      // Persiste `expired` (e seu evento) na mesma transação quando o prazo
      // já venceu; o retorno normal commita antes da resposta 409.
      const currentState = await expireIfNeeded(tx, tenantId, requestId, actor)

      if (currentState === 'expired') return { kind: 'expired' } as const
      if (currentState === null) return { kind: 'not_found' } as const
      if (!isIssuableState(currentState)) {
        return { kind: 'state', state: currentState } as const
      }

      // A solicitação está válida neste ponto (lock + estado + prazo). A
      // contagem abaixo representa apenas tokens efetivamente utilizáveis:
      // não revogados, não expirados e de uma solicitação ainda vigente.
      const [active] = await tx
        .select({ total: count(t.holderAccessToken.tokenId).as('total') })
        .from(t.holderAccessToken)
        .where(
          and(
            eq(t.holderAccessToken.tenantId, tenantId),
            eq(t.holderAccessToken.holderInformationRequestId, requestId),
            isNull(t.holderAccessToken.revokedAt),
            sql`${t.holderAccessToken.expiresAt} > clock_timestamp()`,
          ),
        )

      if (Number((active?.total as unknown as number) ?? 0) >= HOLDER_ACCESS_TOKEN_MAX_ACTIVE) {
        return { kind: 'limit' } as const
      }

      const now = Date.now()
      const requestExpiresAt = request.expiresAt?.getTime() ?? now + TOKEN_TTL_CEILING_MS
      const expiresAt = new Date(Math.min(now + TOKEN_TTL_MS, requestExpiresAt))

      const tokenId = randomUUID()
      const [row] = await tx
        .insert(t.holderAccessToken)
        .values({
          tokenId,
          tenantId,
          holderId: request.holderId,
          holderInformationRequestId: requestId,
          tokenPrefix,
          tokenHash,
          createdBy: actor,
          expiresAt,
        })
        .returning({ createdAt: t.holderAccessToken.createdAt })

      if (!row) throw new Error('failed to insert holder access token')

      await insertHolderInformationRequestEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'access_token_issued',
        fromState: currentState,
        toState: currentState,
        actor,
        details: JSON.stringify({ tokenId, prefix: tokenPrefix }),
      })

      return { kind: 'created', tokenId, token, expiresAt, createdAt: row.createdAt } as const
    })
  }

  const revokeToken = async (
    actor: string,
    tenantId: string,
    requestId: string,
    tokenId: string,
  ): Promise<RevokeHolderAccessTokenResult> => {
    return withTenant(db, tenantId, async (tx) => {
      // Ordem de locks: solicitação → token. A leitura bloqueante garante que
      // não revogamos por engano um token cuja solicitação acabou de ser
      // cancelada (o cancelamento também segura este lock).
      const request = await lockRequestById(tx, tenantId, requestId)

      if (!request) return { kind: 'not_found' } as const

      const [revoked] = await tx
        .update(t.holderAccessToken)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(t.holderAccessToken.tokenId, tokenId),
            eq(t.holderAccessToken.tenantId, tenantId),
            eq(t.holderAccessToken.holderInformationRequestId, requestId),
            isNull(t.holderAccessToken.revokedAt),
          ),
        )
        .returning({ tokenId: t.holderAccessToken.tokenId })

      if (!revoked) {
        const [existing] = await tx
          .select({ tokenId: t.holderAccessToken.tokenId })
          .from(t.holderAccessToken)
          .where(
            and(
              eq(t.holderAccessToken.tokenId, tokenId),
              eq(t.holderAccessToken.tenantId, tenantId),
              eq(t.holderAccessToken.holderInformationRequestId, requestId),
            ),
          )
          .limit(1)

        // Revogação idempotente: token já revogado mantém 204.
        return existing ? ({ kind: 'revoked' } as const) : ({ kind: 'not_found' } as const)
      }

      const state = request.state as HolderInformationRequestState

      await insertHolderInformationRequestEvent(tx, tenantId, {
        holderInformationRequestId: requestId,
        eventType: 'access_token_revoked',
        fromState: state,
        toState: state,
        actor,
        details: JSON.stringify({ tokenId }),
      })

      return { kind: 'revoked' } as const
    })
  }

  return { issueToken, revokeToken, logError }
}

const isIssuableState = (state: HolderInformationRequestState): boolean =>
  state === 'pending' || state === 'in_progress'
