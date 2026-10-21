import { and, createDbPool, eq, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import {
  createIssuerSigningKey,
  createTenant,
  createTestCredentialSigningKey,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { loadActiveSigningKey } from '../../src/services/credential-issuer.js'
import { revokeSigningKey } from '../../src/services/signing-key-lifecycle.js'

// ADR-0029 — ciclo de vida da chave de assinatura na fronteira de persistência.
// Exercita o grant por coluna, a RLS, a monotonicidade do trigger e a mesma
// condição de confiança usada pela emissão e pelos documentos públicos.

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const appPool = createDbPool(db.appUrl)

afterAll(async () => {
  await adminPool.end()
  await appPool.end()
  await db.stop()
})

const rowOf = async (tenantId: string, keyId: string) =>
  (
    await adminPool.db
      .select()
      .from(t.issuerSigningKey)
      .where(and(eq(t.issuerSigningKey.tenantId, tenantId), eq(t.issuerSigningKey.keyId, keyId)))
      .limit(1)
  )[0]

/** Drizzle embrulha o erro do PostgreSQL em `cause`; a mensagem útil está lá. */
const rejectionOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    const cause = (error as { readonly cause?: unknown }).cause
    return [
      error instanceof Error ? error.message : String(error),
      cause instanceof Error ? cause.message : String(cause),
    ].join(' ')
  }
  throw new Error('expected the operation to reject')
}

describe('revokeSigningKey', () => {
  it('revoga com o relógio do banco, é idempotente e some da seleção ativa', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'lifecycle-revoke' })
    await createIssuerSigningKey(adminPool.db, tenantId, createTestCredentialSigningKey('key-1'))
    expect(await loadActiveSigningKey(appPool.db, tenantId)).not.toBeNull()

    const before = Date.now()
    const revoked = await revokeSigningKey(appPool.db, tenantId, 'key-1', undefined)
    expect(revoked).not.toBeNull()
    expect(revoked!.keyId).toBe('key-1')
    expect(revoked!.revokedAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(revoked!.revokedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)

    expect(await loadActiveSigningKey(appPool.db, tenantId)).toBeNull()
    expect((await rowOf(tenantId, 'key-1'))!.revokedAt).toEqual(revoked!.revokedAt)

    // Repetir com instante mais TARDE não adia a revogação: devolve o já
    // registrado (a confiança só pode encolher).
    const again = await revokeSigningKey(appPool.db, tenantId, 'key-1', new Date(Date.now() + 60_000))
    expect(again).toEqual(revoked)
  })

  it('agendamento futuro mantém a chave ativa; antecipar revoga; revoked_at no passado não é confiável', async () => {
    const scheduledTenant = await createTenant(adminPool.db, { name: 'lifecycle-scheduled' })
    await createIssuerSigningKey(adminPool.db, scheduledTenant, createTestCredentialSigningKey('key-1'))
    const future = new Date(Date.now() + 3_600_000)
    expect(await revokeSigningKey(appPool.db, scheduledTenant, 'key-1', future)).toEqual({
      keyId: 'key-1',
      revokedAt: future,
    })
    // O instante ainda não chegou: publicada/ativa continua sendo selecionada.
    expect(await loadActiveSigningKey(appPool.db, scheduledTenant)).not.toBeNull()

    // Antecipar a expiração é seguro (a confiança encolhe): uma chave
    // comprometida com expiração agendada pode ser revogada agora.
    const earlier = new Date(Date.now() + 60_000)
    expect(await revokeSigningKey(appPool.db, scheduledTenant, 'key-1', earlier)).toEqual({
      keyId: 'key-1',
      revokedAt: earlier,
    })
    expect(await loadActiveSigningKey(appPool.db, scheduledTenant)).not.toBeNull()

    const immediate = await revokeSigningKey(appPool.db, scheduledTenant, 'key-1', undefined)
    expect(immediate!.revokedAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await loadActiveSigningKey(appPool.db, scheduledTenant)).toBeNull()

    // Depois de antecipado, um pedido posterior não reabre a confiança.
    expect(await revokeSigningKey(appPool.db, scheduledTenant, 'key-1', future)).toEqual(immediate)

    // Uma chave já vencida (revoked_at no passado) é excluída mesmo que a linha
    // tenha sido publicada como ativa.
    const expiredTenant = await createTenant(adminPool.db, { name: 'lifecycle-expired' })
    await createIssuerSigningKey(adminPool.db, expiredTenant, createTestCredentialSigningKey('key-1'), {
      revokedAt: new Date(Date.now() - 1_000),
    })
    expect(await loadActiveSigningKey(appPool.db, expiredTenant)).toBeNull()
  })

  it('isola tenants: revogar key-1 em A não toca a key-1 de B', async () => {
    const tenantA = await createTenant(adminPool.db, { name: 'lifecycle-a' })
    const tenantB = await createTenant(adminPool.db, { name: 'lifecycle-b' })
    await createIssuerSigningKey(adminPool.db, tenantA, createTestCredentialSigningKey('key-1'))
    await createIssuerSigningKey(adminPool.db, tenantB, createTestCredentialSigningKey('key-1'))

    expect(await revokeSigningKey(appPool.db, tenantA, 'key-1', undefined)).not.toBeNull()
    expect((await rowOf(tenantA, 'key-1'))!.revokedAt).not.toBeNull()
    expect((await rowOf(tenantB, 'key-1'))!.revokedAt).toBeNull()

    // A chave de B continua ativa e pode ser revogada no contexto de B.
    expect(await loadActiveSigningKey(appPool.db, tenantB)).not.toBeNull()
    expect(await revokeSigningKey(appPool.db, tenantB, 'key-1', undefined)).not.toBeNull()
    expect((await rowOf(tenantB, 'key-1'))!.revokedAt).not.toBeNull()

    // Chave inexistente é indistinguível de chave de outro tenant: 404.
    expect(await revokeSigningKey(appPool.db, tenantA, 'missing', undefined)).toBeNull()
  })

  it('o app só atualiza revoked_at (grant por coluna)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'lifecycle-grant' })
    await createIssuerSigningKey(adminPool.db, tenantId, createTestCredentialSigningKey('key-1'))

    await expect(
      rejectionOf(
        withTenant(appPool.db, tenantId, async (tx) => {
          await tx
            .update(t.issuerSigningKey)
            .set({ keyId: 'hijacked' })
            .where(eq(t.issuerSigningKey.tenantId, tenantId))
        }),
      ),
    ).resolves.toMatch(/permission denied/i)
    expect((await rowOf(tenantId, 'key-1'))!.keyId).toBe('key-1')
  })

  it('o trigger só permite encolher a revogação e protege a identidade; rotação (active) é permitida', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'lifecycle-trigger' })
    await createIssuerSigningKey(adminPool.db, tenantId, createTestCredentialSigningKey('key-1'))
    const revoked = await revokeSigningKey(appPool.db, tenantId, 'key-1', undefined)

    const update = (values: Partial<typeof t.issuerSigningKey.$inferInsert>) =>
      adminPool.db
        .update(t.issuerSigningKey)
        .set(values)
        .where(and(eq(t.issuerSigningKey.tenantId, tenantId), eq(t.issuerSigningKey.keyId, 'key-1')))

    // Antecipar é permitido (a confiança encolhe).
    const earlier = new Date(revoked!.revokedAt.getTime() - 60_000)
    await update({ revokedAt: earlier })
    expect((await rowOf(tenantId, 'key-1'))!.revokedAt).toEqual(earlier)

    // Adiar ou desfazer NÃO é permitido (a confiança cresceria).
    expect(await rejectionOf(update({ revokedAt: new Date(earlier.getTime() + 30_000) }))).toMatch(
      /revogação é monotônica/,
    )
    expect(await rejectionOf(update({ revokedAt: null }))).toMatch(/revogação é monotônica/)
    expect(await rejectionOf(update({ keyId: 'other-key' }))).toMatch(/identidade é imutável/)
    expect(
      await rejectionOf(update({ kmsKeyReference: 'arn:aws:kms:sa-east-1:111122223333:key/other' })),
    ).toMatch(/identidade é imutável/)

    // Rotação é permitida e não mexe na revogação.
    await update({ active: false })
    const row = await rowOf(tenantId, 'key-1')
    expect(row!.active).toBe(false)
    expect(row!.revokedAt).toEqual(earlier)
  })

  it('expõe a referência KMS da chave ativa sem consultar a AWS', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'lifecycle-kms-reference' })
    const kmsKeyReference = 'arn:aws:kms:sa-east-1:111122223333:key/1234abcd'
    await createIssuerSigningKey(adminPool.db, tenantId, createTestCredentialSigningKey('key-1'), {
      kmsKeyReference,
    })

    expect(await loadActiveSigningKey(adminPool.db, tenantId)).toMatchObject({
      keyId: 'key-1',
      kmsKeyReference,
    })
  })
})
