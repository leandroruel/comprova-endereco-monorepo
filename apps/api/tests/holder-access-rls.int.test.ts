import { randomUUID } from 'node:crypto'
import { createDbPool, eq, runMigrations, sql, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { startTestDb, TEST_APP_DB_PASSWORD } from '@comprova/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import {
  hashHolderAccessToken,
  holderTokenPrefixOf,
  newHolderAccessToken,
} from '../src/modules/holder/holder-token.js'

const PEPPER = 'test-pepper-123'

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const admin = postgres(db.adminUrl, { max: 1 })
const appPool = createDbPool(db.appUrl)

const tenantA = randomUUID()
const tenantB = randomUUID()

interface Fixture {
  readonly tenantId: string
  readonly holderId: string
  readonly requestId: string
}

const fixtures = new Map<string, Fixture>()

const createFixture = async (tenantId: string, externalReference: string): Promise<Fixture> => {
  const holderId = randomUUID()
  const requestId = randomUUID()
  await withTenant(appPool.db, tenantId, async (tx) => {
    await tx.insert(t.holder).values({
      holderId,
      tenantId,
      externalReference,
      name: 'Titular RLS',
      documentHash: 'hash-' + externalReference,
      documentType: 'CPF',
    })
    await tx.insert(t.holderInformationRequest).values({
      id: requestId,
      tenantId,
      holderId,
      type: 'documento_complementar',
      purpose: 'Comprovante',
      items: [
        {
          itemId: 'address-proof',
          description: 'Comprovante',
          required: true,
          documentType: 'proof_of_address',
        },
      ],
      state: 'pending',
      createdBy: 'test',
    })
  })
  return { tenantId, holderId, requestId }
}

const insertToken = async (fixture: Fixture, overrides?: { revoked?: boolean; expired?: boolean }) => {
  const token = newHolderAccessToken()
  const tokenId = randomUUID()
  const expired = overrides?.expired === true
  const now = Date.now()
  const expiresAt = expired ? new Date(now - 60_000) : new Date(now + 7 * 24 * 3600_000)
  await withTenant(appPool.db, fixture.tenantId, async (tx) => {
    await tx.insert(t.holderAccessToken).values({
      tokenId,
      tenantId: fixture.tenantId,
      holderId: fixture.holderId,
      holderInformationRequestId: fixture.requestId,
      tokenPrefix: holderTokenPrefixOf(token),
      tokenHash: hashHolderAccessToken(token, PEPPER),
      createdBy: 'test',
      // `holder_access_token_expiry_check` exige expires_at > created_at:
      // um token expirado só pode ter sido criado antes do vencimento.
      ...(expired ? { createdAt: new Date(now - 120_000) } : {}),
      expiresAt,
      ...(overrides?.revoked === true ? { revokedAt: new Date(now - 1000) } : {}),
    })
  })
  return { tokenId, token }
}

const resolveToken = async (token: string) =>
  appPool.db.execute(sql`
    SELECT token_id, tenant_id, holder_id, holder_information_request_id, first_accessed_at
      FROM public.app_resolve_holder_access_token(${holderTokenPrefixOf(token)}, ${hashHolderAccessToken(token, PEPPER)})
  `) as Promise<readonly Record<string, unknown>[]>

/**
 * Drizzle embrulha erros do driver em `DrizzleQueryError`; o nome da constraint
 * fica em `cause`. Percorre a cadeia para garantir que a barreira correta
 * disparou (não um erro qualquer).
 */
const expectConstraintError = async (operation: Promise<unknown>, constraint: string): Promise<void> => {
  let caught: unknown
  try {
    await operation
    expect.unreachable('deveria ter lançado erro de constraint')
  } catch (error) {
    caught = error
  }
  let current: unknown = caught
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { constraint_name?: unknown; constraint?: unknown }
    if (candidate.constraint_name === constraint || candidate.constraint === constraint) return
    current = (current as { cause?: unknown }).cause
  }
  expect.fail(`erro não menciona a constraint '${constraint}': ${String(caught)}`)
}

beforeAll(async () => {
  await admin`
    INSERT INTO tenant (tenant_id, name) VALUES (${tenantA}, 'Tenant A RLS'), (${tenantB}, 'Tenant B RLS')`
  fixtures.set('A', await createFixture(tenantA, 'rls-a-001'))
  fixtures.set('B', await createFixture(tenantB, 'rls-b-001'))
})

afterAll(async () => {
  await admin.end()
  await appPool.end()
  await db.stop()
})

describe('F4.2 — RLS e isolamento entre tenants', () => {
  it('app_user só lê linhas do próprio tenant (token, resposta, documento)', async () => {
    const { requestId: reqA } = fixtures.get('A')!
    const { requestId: reqB } = fixtures.get('B')!

    await withTenant(appPool.db, tenantA, async (tx) => {
      await tx.insert(t.holderItemResponse).values({
        responseId: randomUUID(),
        tenantId: tenantA,
        holderInformationRequestId: reqA,
        itemId: 'address-proof',
        value: 'Resposta A',
        createdBy: 'test',
      })
      await tx.insert(t.holderInformationRequestDocument).values({
        documentId: randomUUID(),
        tenantId: tenantA,
        holderInformationRequestId: reqA,
        itemId: 'address-proof',
        uploadState: 'pending',
        storageKey: `tenants/${tenantA}/holder-requests/${reqA}/${randomUUID()}`,
      })
    })

    const visibleFromA = await withTenant(appPool.db, tenantA, async (tx) => ({
      requests: await tx.select({ id: t.holderInformationRequest.id }).from(t.holderInformationRequest),
      tokens: await tx.select().from(t.holderAccessToken),
      responses: await tx.select().from(t.holderItemResponse),
      documents: await tx.select().from(t.holderInformationRequestDocument),
    }))
    expect(visibleFromA.requests.map((r) => r.id)).toEqual([reqA])
    expect(visibleFromA.responses).toHaveLength(1)
    expect(visibleFromA.documents).toHaveLength(1)
    expect(visibleFromA.tokens).toHaveLength(0)

    const visibleFromB = await withTenant(appPool.db, tenantB, async (tx) => ({
      requests: await tx.select({ id: t.holderInformationRequest.id }).from(t.holderInformationRequest),
      responses: await tx.select().from(t.holderItemResponse),
      documents: await tx.select().from(t.holderInformationRequestDocument),
    }))
    expect(visibleFromB.requests.map((r) => r.id)).toEqual([reqB])
    expect(visibleFromB.responses).toHaveLength(0)
    expect(visibleFromB.documents).toHaveLength(0)
  })

  it('WITH CHECK rejeita insert com tenant divergente', async () => {
    const fixtureA = fixtures.get('A')!

    await expect(
      withTenant(appPool.db, tenantA, async (tx) => {
        await tx.insert(t.holderAccessToken).values({
          tokenId: randomUUID(),
          // Linha apontando para outro tenant dentro da transação do tenant A.
          tenantId: tenantB,
          holderId: fixtureA.holderId,
          holderInformationRequestId: fixtureA.requestId,
          tokenPrefix: holderTokenPrefixOf(newHolderAccessToken()),
          tokenHash: hashHolderAccessToken(newHolderAccessToken(), PEPPER),
          createdBy: 'attacker',
          expiresAt: new Date(Date.now() + 3600_000),
        })
      }),
    ).rejects.toThrow()
  })

  it('UPDATE/DELETE cross-tenant não afeta linhas (0 rows)', async () => {
    const fixtureB = fixtures.get('B')!
    const { tokenId } = await insertToken(fixtureB)

    const attackerUpdated = await withTenant(appPool.db, tenantA, async (tx) =>
      tx
        .update(t.holderAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(t.holderAccessToken.tokenId, tokenId)),
    )
    expect(attackerUpdated).toHaveLength(0)

    const attackerDeleted = withTenant(appPool.db, tenantA, async (tx) =>
      tx.delete(t.holderAccessToken).where(eq(t.holderAccessToken.tokenId, tokenId)),
    )
    // app_user nem tem GRANT DELETE em holder_access_token (tokens são
    // revogados, nunca apagados) — a tentativa falha antes mesmo do RLS.
    await expect(attackerDeleted).rejects.toThrow()

    const stillThere = await admin`
      SELECT count(*)::int AS n FROM holder_access_token WHERE token_id = ${tokenId} AND revoked_at IS NULL`
    expect(stillThere[0]!.n).toBe(1)
  })

  it('sem app.tenant_id configurado, app_user não lê nenhuma linha', async () => {
    const rows = (await appPool.db.execute(
      sql`SELECT count(*)::int AS n FROM holder_access_token`,
    )) as unknown as readonly { n: number }[]
    expect(rows[0]!.n).toBe(0)
    const requests = (await appPool.db.execute(
      sql`SELECT count(*)::int AS n FROM holder_information_request`,
    )) as unknown as readonly { n: number }[]
    expect(requests[0]!.n).toBe(0)
  })
})

describe('F4.2 — resolver SECURITY DEFINER', () => {
  it('resolve somente token válido, não revogado e não expirado', async () => {
    const fixtureA = fixtures.get('A')!
    const valid = await insertToken(fixtureA)
    await insertToken(fixtureA, { revoked: true })
    await insertToken(fixtureA, { expired: true })

    const resolved = await resolveToken(valid.token)
    expect(resolved).toHaveLength(1)
    const row = resolved[0]!
    expect(row.token_id).toBe(valid.tokenId)
    expect(row.tenant_id).toBe(tenantA)
    expect(row.holder_id).toBe(fixtureA.holderId)
    expect(row.holder_information_request_id).toBe(fixtureA.requestId)
    expect(row.first_accessed_at).toBeNull()
  })

  it('hash divergente com o mesmo prefixo não resolve', async () => {
    const fixtureA = fixtures.get('A')!
    const { token } = await insertToken(fixtureA)

    // Mesmo prefixo, hash de outro token.
    const wrong = await appPool.db.execute(sql`
      SELECT * FROM public.app_resolve_holder_access_token(${holderTokenPrefixOf(token)}, ${hashHolderAccessToken(newHolderAccessToken(), PEPPER)})
    `)
    expect(wrong).toHaveLength(0)
  })

  it('funciona sem contexto de tenant (pré-tenant por design) e retorna o tenant da linha', async () => {
    const fixtureB = fixtures.get('B')!
    const { token } = await insertToken(fixtureB)

    const resolved = await resolveToken(token)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.tenant_id).toBe(tenantB)
  })

  it('não revela colunas sensíveis além das declaradas', async () => {
    const fixtureA = fixtures.get('A')!
    const { token } = await insertToken(fixtureA)
    const resolved = await resolveToken(token)
    const keys = Object.keys(resolved[0]!).sort()
    expect(keys).toEqual([
      'first_accessed_at',
      'holder_id',
      'holder_information_request_id',
      'tenant_id',
      'token_id',
    ])
  })
})

describe('F4.2 — constraints de integridade', () => {
  it('resposta é única por (solicitação, item)', async () => {
    const fixtureA = fixtures.get('A')!
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderItemResponse).values([
          {
            responseId: randomUUID(),
            tenantId: fixtureA.tenantId,
            holderInformationRequestId: fixtureA.requestId,
            itemId: 'dupe-item',
            value: 'primeira',
            createdBy: 'test',
          },
          {
            responseId: randomUUID(),
            tenantId: fixtureA.tenantId,
            holderInformationRequestId: fixtureA.requestId,
            itemId: 'dupe-item',
            value: 'segunda',
            createdBy: 'test',
          },
        ])
      }),
      'holder_item_response_request_item_unique',
    )
  })

  it('valor da resposta: 1..5000 caracteres e trim obrigatório', async () => {
    const fixtureA = fixtures.get('A')!
    const base = {
      tenantId: fixtureA.tenantId,
      holderInformationRequestId: fixtureA.requestId,
      createdBy: 'test',
    }
    await expect(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderItemResponse).values({
          responseId: randomUUID(),
          ...base,
          itemId: 'len-item-1',
          value: 'a'.repeat(5001),
        })
      }),
    ).rejects.toThrow()
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderItemResponse).values({
          responseId: randomUUID(),
          ...base,
          itemId: 'len-item-2',
          value: ' com espaços ',
        })
      }),
      'holder_item_response_value_trimmed_check',
    )
    await expect(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderItemResponse).values({
          responseId: randomUUID(),
          ...base,
          itemId: 'len-item-3',
          value: '',
        })
      }),
    ).rejects.toThrow()
  })

  it('documento: pending sem metadados, stored com metadados completos', async () => {
    const fixtureA = fixtures.get('A')!
    const requestId = fixtureA.requestId
    const keyOf = () => `tenants/${fixtureA.tenantId}/holder-requests/${requestId}/${randomUUID()}`

    // pending com content_type → viola state_check
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderInformationRequestDocument).values({
          documentId: randomUUID(),
          tenantId: fixtureA.tenantId,
          holderInformationRequestId: requestId,
          itemId: 'address-proof',
          uploadState: 'pending',
          storageKey: keyOf(),
          contentType: 'image/png',
        })
      }),
      'holder_information_request_document_state_check',
    )

    // stored sem sha256 → viola state_check
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderInformationRequestDocument).values({
          documentId: randomUUID(),
          tenantId: fixtureA.tenantId,
          holderInformationRequestId: requestId,
          itemId: 'address-proof',
          uploadState: 'stored',
          storageKey: keyOf(),
          contentType: 'image/png',
          sizeBytes: 16,
          originalFilename: 'doc.png',
        })
      }),
      'holder_information_request_document_state_check',
    )

    // storage_key fora do padrão → viola check de chave
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderInformationRequestDocument).values({
          documentId: randomUUID(),
          tenantId: fixtureA.tenantId,
          holderInformationRequestId: requestId,
          itemId: 'address-proof',
          uploadState: 'pending',
          storageKey: `tenants/${fixtureA.tenantId}/evidence/${randomUUID()}`,
        })
      }),
      'holder_information_request_document_storage_key_check',
    )

    // stored válido passa.
    await withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
      await tx.insert(t.holderInformationRequestDocument).values({
        documentId: randomUUID(),
        tenantId: fixtureA.tenantId,
        holderInformationRequestId: requestId,
        itemId: 'address-proof',
        uploadState: 'stored',
        storageKey: keyOf(),
        contentType: 'image/png',
        sizeBytes: 16,
        sha256: Buffer.alloc(32, 7),
        originalFilename: 'doc.png',
      })
    })
  })

  it('sha256 com tamanho incorreto é rejeitado', async () => {
    const fixtureA = fixtures.get('A')!
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderInformationRequestDocument).values({
          documentId: randomUUID(),
          tenantId: fixtureA.tenantId,
          holderInformationRequestId: fixtureA.requestId,
          itemId: 'address-proof',
          uploadState: 'stored',
          storageKey: `tenants/${fixtureA.tenantId}/holder-requests/${fixtureA.requestId}/${randomUUID()}`,
          contentType: 'image/png',
          sizeBytes: 16,
          sha256: Buffer.alloc(31, 1),
          originalFilename: 'doc.png',
        })
      }),
      'holder_information_request_document_sha256_check',
    )
  })

  it('token com hash de tamanho incorreto é rejeitado', async () => {
    const fixtureA = fixtures.get('A')!
    await expectConstraintError(
      withTenant(appPool.db, fixtureA.tenantId, async (tx) => {
        await tx.insert(t.holderAccessToken).values({
          tokenId: randomUUID(),
          tenantId: fixtureA.tenantId,
          holderId: fixtureA.holderId,
          holderInformationRequestId: fixtureA.requestId,
          tokenPrefix: holderTokenPrefixOf(newHolderAccessToken()),
          tokenHash: Buffer.alloc(31, 1),
          createdBy: 'test',
          expiresAt: new Date(Date.now() + 3600_000),
        })
      }),
      'holder_access_token_hash_check',
    )
  })
})
