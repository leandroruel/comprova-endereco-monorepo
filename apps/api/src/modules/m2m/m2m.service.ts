import { and, eq, isNull } from '@comprova/db'
import * as t from '@comprova/db'
import {
  newApiKey,
  keyPrefixOf,
  makeApiKeyHasher,
  type Db,
} from '@comprova/db'
import {
  type ApiKeyDto,
  type CreateApiKeyRequest,
} from '@comprova/contracts'
import { randomUUID } from 'node:crypto'

export interface M2MServiceDeps {
  readonly db: Db
  readonly apiKeyPepper: string
}

export const makeM2MService = (deps: M2MServiceDeps) => {
  const { db, apiKeyPepper } = deps
  const hasher = makeApiKeyHasher(apiKeyPepper)

  /**
   * Verifica se o usuário é membro da organização e, opcionalmente, tem o
   * papel mínimo exigido. Lança erro caso contrário.
   */
  const ensureMembership = async (
    tenantId: string,
    userId: string,
    requiredRole?: 'owner' | 'admin' | 'member',
  ): Promise<void> => {
    const member = await db
      .select({ userId: t.organizationMember.userId, role: t.organizationMember.role })
      .from(t.organizationMember)
      .where(
        and(
          eq(t.organizationMember.tenantId, tenantId),
          eq(t.organizationMember.userId, userId),
        ),
      )
      .limit(1)

    if (member.length === 0) {
      throw new Error('user is not a member of this organization')
    }

    if (requiredRole) {
      const hierarchy = ['member', 'admin', 'owner']
      const userLevel = hierarchy.indexOf(member[0]!.role)
      const minLevel = hierarchy.indexOf(requiredRole)
      if (userLevel < minLevel) {
        throw new Error('insufficient role for this operation')
      }
    }
  }

  /**
   * Cria uma credencial de API M2M associada à organização.
   * Retorna o segredo em claro apenas uma vez (na criação).
   */
  const createApiKey = async (
    tenantId: string,
    create: CreateApiKeyRequest,
    userId: string,
  ): Promise<{ apiKey: ApiKeyDto; secret: string }> => {
    await ensureMembership(tenantId, userId, 'admin')

    const plaintext = newApiKey()
    const prefix = keyPrefixOf(plaintext)
    const keyHash = hasher.hash(plaintext)

    const expiresAt = create.expiresInDays
      ? new Date(Date.now() + create.expiresInDays * 24 * 60 * 60 * 1000)
      : null

    const insertedKeys = await db
      .insert(t.apiKey)
      .values({
        apiKeyId: randomUUID(),
        tenantId,
        keyPrefix: prefix,
        keyHash,
        scopes: create.scopes,
        keyType: create.keyType,
        expiresAt,
      })
      .returning()

    const apiKey = insertedKeys[0]
    if (!apiKey) {
      throw new Error('failed to create API key')
    }

    return {
      apiKey: {
        apiKeyId: apiKey.apiKeyId,
        tenantId: apiKey.tenantId,
        keyPrefix: apiKey.keyPrefix,
        key: undefined, // nunca expõe o segredo no objeto da chave
        scopes: apiKey.scopes,
        keyType: apiKey.keyType,
        revokedAt: apiKey.revokedAt?.toISOString() ?? null,
        expiresAt: apiKey.expiresAt?.toISOString() ?? null,
        lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
        createdAt: apiKey.createdAt.toISOString(),
      },
      secret: plaintext,
    }
  }

  /**
   * Lista API keys da organização (sem expor o segredo).
   */
  const listApiKeys = async (
    tenantId: string,
    userId: string,
  ): Promise<ApiKeyDto[]> => {
    await ensureMembership(tenantId, userId)

    const rows = await db
      .select({
        apiKeyId: t.apiKey.apiKeyId,
        tenantId: t.apiKey.tenantId,
        keyPrefix: t.apiKey.keyPrefix,
        scopes: t.apiKey.scopes,
        keyType: t.apiKey.keyType,
        revokedAt: t.apiKey.revokedAt,
        expiresAt: t.apiKey.expiresAt,
        lastUsedAt: t.apiKey.lastUsedAt,
        createdAt: t.apiKey.createdAt,
      })
      .from(t.apiKey)
      .where(
        and(
          eq(t.apiKey.tenantId, tenantId),
          isNull(t.apiKey.revokedAt),
        ),
      )

    return rows.map((row) => ({
      apiKeyId: row.apiKeyId,
      tenantId: row.tenantId,
      keyPrefix: row.keyPrefix,
      key: undefined, // nunca expõe o segredo
      scopes: row.scopes,
      keyType: row.keyType,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  /**
   * Revoga uma API key da organização.
   */
  const revokeApiKey = async (
    tenantId: string,
    apiKeyId: string,
    userId: string,
  ): Promise<boolean> => {
    await ensureMembership(tenantId, userId, 'admin')

    const [updated] = await db
      .update(t.apiKey)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(t.apiKey.apiKeyId, apiKeyId),
          eq(t.apiKey.tenantId, tenantId),
          isNull(t.apiKey.revokedAt),
        ),
      )
      .returning({ apiKeyId: t.apiKey.apiKeyId })

    return updated !== undefined
  }

  return {
    createApiKey,
    listApiKeys,
    revokeApiKey,
  }
}
