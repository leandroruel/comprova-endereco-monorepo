import { and, eq, isNull, or, gt, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import type { Db } from '@comprova/db'
import { cacheInvalidate } from '../../plugins/auth.js'
import { makeApiKeyHasher, newApiKey, keyPrefixOf } from '@comprova/db'
import { validateScopesForKeyType } from '../../plugins/scope.js'

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

const ROLES_ALLOWED_TO_MANAGE_KEYS = ['owner', 'admin']

const ensureMembership = async (
  db: Db,
  tenantId: string,
  userId: string,
  requireAdmin: boolean,
): Promise<void> => {
  const [member] = await withTenant(db, tenantId, async (tx) => {
    return tx
      .select({ role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(and(eq(t.organizationMember.tenantId, tenantId), eq(t.organizationMember.userId, userId)))
      .limit(1)
  })

  if (!member) {
    throw new AuthorizationError('usuário não é membro da organização')
  }

  if (requireAdmin && !ROLES_ALLOWED_TO_MANAGE_KEYS.includes(member.role)) {
    throw new AuthorizationError('usuário não possui papel de admin ou owner na organização')
  }
}

export const makeM2MService = (deps: { readonly db: Db; readonly apiKeyPepper: string }) => {
  const { db, apiKeyPepper } = deps
  const hasher = makeApiKeyHasher(apiKeyPepper)

  const createApiKey = async (
    tenantId: string,
    userId: string,
    create: {
      readonly name: string
      readonly scopes: string[]
      readonly keyType: string
      readonly expiresAt?: string
    },
  ): Promise<{ apiKeyId: string; keyPrefix: string; secret: string }> => {
    // Somente membros admin/owner podem criar API keys.
    await ensureMembership(db, tenantId, userId, true)

    // Validar escopos conhecidos e permitidos para o tipo de chave.
    validateScopesForKeyType(create.keyType as 'user' | 'm2m', create.scopes)

    const apiKeyId = randomUUID()
    const secret = newApiKey()
    const keyPrefix = keyPrefixOf(secret)
    const keyHash = hasher.hash(secret)

    const [inserted] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .insert(t.apiKey)
        .values({
          apiKeyId,
          tenantId,
          keyPrefix,
          keyHash,
          scopes: create.scopes,
          keyType: create.keyType,
          expiresAt: create.expiresAt ? new Date(create.expiresAt) : null,
        })
        .returning()
    })

    if (!inserted) throw new Error('failed to create API key')

    return {
      apiKeyId: inserted.apiKeyId,
      keyPrefix: inserted.keyPrefix,
      secret,
    }
  }

  const getApiKey = async (
    apiKeyId: string,
    tenantId: string,
  ): Promise<{
    apiKeyId: string
    tenantId: string
    keyPrefix: string
    scopes: string[]
    keyType: string
    revokedAt: string | null
    expiresAt: string | null
    lastUsedAt: string | null
    createdAt: string
  } | null> => {
    const [key] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.apiKey)
        .where(and(eq(t.apiKey.apiKeyId, apiKeyId), eq(t.apiKey.tenantId, tenantId)))
        .limit(1)
    })

    if (!key) return null

    return {
      apiKeyId: key.apiKeyId,
      tenantId: key.tenantId,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      keyType: key.keyType,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      expiresAt: key.expiresAt?.toISOString() ?? null,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    }
  }

  const listApiKeys = async (
    tenantId: string,
    userId: string,
  ): Promise<
    {
      apiKeyId: string
      tenantId: string
      keyPrefix: string
      scopes: string[]
      keyType: string
      revokedAt: string | null
      expiresAt: string | null
      lastUsedAt: string | null
      createdAt: string
    }[]
  > => {
    // Somente membros da organização podem listar API keys.
    await ensureMembership(db, tenantId, userId, false)

    const rows = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.apiKey)
        .where(
          and(
            eq(t.apiKey.tenantId, tenantId),
            isNull(t.apiKey.revokedAt),
            or(isNull(t.apiKey.expiresAt), gt(t.apiKey.expiresAt, new Date())),
          ),
        )
        .orderBy(t.apiKey.createdAt)
    })

    return rows.map((row) => ({
      apiKeyId: row.apiKeyId,
      tenantId: row.tenantId,
      keyPrefix: row.keyPrefix,
      scopes: row.scopes,
      keyType: row.keyType,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  const revokeApiKey = async (apiKeyId: string, tenantId: string, userId: string): Promise<boolean> => {
    // Somente membros admin/owner podem revogar API keys.
    await ensureMembership(db, tenantId, userId, true)

    const [updated] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .update(t.apiKey)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(t.apiKey.apiKeyId, apiKeyId), eq(t.apiKey.tenantId, tenantId), isNull(t.apiKey.revokedAt)),
        )
        .returning()
    })

    if (updated) {
      cacheInvalidate(apiKeyId)
    }

    return !!updated
  }

  return {
    createApiKey,
    getApiKey,
    listApiKeys,
    revokeApiKey,
  }
}
