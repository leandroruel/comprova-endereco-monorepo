import { createDbPool, eq, runMigrations, sql } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger, type Logger } from '@comprova/observability'
import {
  createIssuerSigningKey,
  createTenant,
  createTestCredentialSigningKey,
  signingKeysConfig,
  startTestDb,
  TEST_APP_DB_PASSWORD,
  type TestCredentialSigningKey,
} from '@comprova/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { loadActiveSigningKey } from './credential-issuer.js'
import { rotateSigningKey, SigningKeyRotationError } from './signing-key-rotation.js'
import { parseSigningKeys, type SigningKeyEntry } from './signing-keys.js'

// Roadmap #24 / etapa 24.2 — rotação de chave de assinatura. Exercita a
// operação de domínio contra o Postgres real: atomicidade, concorrência,
// idempotência, `superseded ≠ revoked`, seleção da nova chave e isolamento.

const logger = createLogger({ level: 'silent' })

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

/** Entry de configuração equivalente ao que o boot da API leria. */
const entryOf = (tenantId: string, key: TestCredentialSigningKey): SigningKeyEntry =>
  parseSigningKeys(signingKeysConfig([{ tenantId, key }]))[0]!

const rowsOf = async (tenantId: string) =>
  adminPool.db.select().from(t.issuerSigningKey).where(eq(t.issuerSigningKey.tenantId, tenantId))

const activeRowsOf = async (tenantId: string) => (await rowsOf(tenantId)).filter((row) => row.active)

describe('rotateSigningKey', () => {
  it('rotaciona: a antiga vira SUPERADA (publicada, não revogada), a nova passa a ativa', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-basic' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const newKey = createTestCredentialSigningKey('key-new')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    const outcome = await rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), logger)

    expect(outcome).toEqual({
      tenantId,
      keyId: 'key-new',
      previousKeyId: 'key-old',
      status: 'rotated',
    })

    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(2)
    const old = rows.find((row) => row.keyId === 'key-old')!
    const fresh = rows.find((row) => row.keyId === 'key-new')!

    // A antiga continua publicada e CONFÁVEL: só deixou de assinar.
    expect(old.active).toBe(false)
    expect(old.revokedAt).toBeNull()
    expect(fresh.active).toBe(true)
    expect(fresh.revokedAt).toBeNull()

    // O índice parcial único garante no máximo uma ativa.
    expect(await activeRowsOf(tenantId)).toHaveLength(1)

    // A emissão passa a selecionar a nova chave (caminho real de seleção).
    expect(await loadActiveSigningKey(adminPool.db, tenantId)).toMatchObject({ keyId: 'key-new' })
  })

  it('não revoga a chave antiga: `superseded` e `revoked_at` são eixos separados', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-not-revocation' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const newKey = createTestCredentialSigningKey('key-new')
    const oldId = await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    await rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), logger)

    const old = (
      await adminPool.db
        .select()
        .from(t.issuerSigningKey)
        .where(eq(t.issuerSigningKey.issuerSigningKeyId, oldId))
    )[0]!
    expect(old.active).toBe(false)
    expect(old.revokedAt).toBeNull()
  })

  it('repetir a rotação para a chave já ativa é no-op (idempotente)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-idempotent' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const newKey = createTestCredentialSigningKey('key-new')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    await rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), logger)
    const again = await rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), logger)

    expect(again).toEqual({
      tenantId,
      keyId: 'key-new',
      previousKeyId: null,
      status: 'unchanged',
    })
    expect(await rowsOf(tenantId)).toHaveLength(2)
    expect(await activeRowsOf(tenantId)).toHaveLength(1)
  })

  it('duas rotações: A superada, B superada, C ativa', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-twice' })
    const keyA = createTestCredentialSigningKey('key-a')
    const keyB = createTestCredentialSigningKey('key-b')
    const keyC = createTestCredentialSigningKey('key-c')
    await createIssuerSigningKey(adminPool.db, tenantId, keyA)

    await rotateSigningKey(adminPool.db, entryOf(tenantId, keyB), logger)
    await rotateSigningKey(adminPool.db, entryOf(tenantId, keyC), logger)

    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.active).map((row) => row.keyId)).toEqual(['key-c'])
    expect(rows.filter((row) => row.keyId === 'key-a' && !row.active)).toHaveLength(1)
    expect(rows.filter((row) => row.keyId === 'key-b' && !row.active)).toHaveLength(1)
    expect(rows.every((row) => row.revokedAt === null)).toBe(true)

    expect(await loadActiveSigningKey(adminPool.db, tenantId)).toMatchObject({ keyId: 'key-c' })
  })

  it('recusa reativar um key_id SUPERADO', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-superseded' })
    const keyA = createTestCredentialSigningKey('key-a')
    const keyB = createTestCredentialSigningKey('key-b')
    await createIssuerSigningKey(adminPool.db, tenantId, keyA)
    await rotateSigningKey(adminPool.db, entryOf(tenantId, keyB), logger)

    await expect(rotateSigningKey(adminPool.db, entryOf(tenantId, keyA), logger)).rejects.toBeInstanceOf(
      SigningKeyRotationError,
    )

    // Nada mudou: B continua a única ativa.
    expect((await activeRowsOf(tenantId)).map((row) => row.keyId)).toEqual(['key-b'])
  })

  it('recusa sobrescrever material sob um key_id já publicado', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-overwrite' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const differentMaterial = createTestCredentialSigningKey('key-old')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    await expect(
      rotateSigningKey(adminPool.db, entryOf(tenantId, differentMaterial), logger),
    ).rejects.toBeInstanceOf(SigningKeyRotationError)

    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.active).toBe(true)
  })

  it('recusa reutilizar o material de outra chave sob um key_id novo', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-reuse-material' })
    const oldKey = createTestCredentialSigningKey('key-old')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    // Mesmo material privado, `key_id` novo: não é uma rotação legítima.
    const reused: TestCredentialSigningKey = { ...oldKey, keyId: 'key-new' }

    await expect(rotateSigningKey(adminPool.db, entryOf(tenantId, reused), logger)).rejects.toBeInstanceOf(
      SigningKeyRotationError,
    )

    expect((await activeRowsOf(tenantId)).map((row) => row.keyId)).toEqual(['key-old'])
  })

  it('falha depois de escrever desfaz UPDATE e INSERT (atomicidade)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-atomic' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const newKey = createTestCredentialSigningKey('key-new')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    // O logger é chamado DEPOIS do UPDATE (superar a antiga) e do INSERT (nova),
    // e ANTES do commit. Explodir aqui simula uma falha no meio da operação.
    const failingLogger: Logger = {
      ...logger,
      info: () => {
        throw new Error('simulated failure after writes')
      },
    }

    await expect(rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), failingLogger)).rejects.toThrow(
      'simulated failure after writes',
    )

    // Rollback completo: a antiga continua ativa e a nova não existe.
    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyId).toBe('key-old')
    expect(rows[0]!.active).toBe(true)
  })

  it('falha fechado quando outra transação segura a chave ativa (lock timeout)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-locked' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const newKey = createTestCredentialSigningKey('key-new')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    const holder = createDbPool(db.adminUrl, { max: 1 })
    try {
      await holder.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM issuer_signing_key WHERE tenant_id = ${tenantId} AND active FOR UPDATE`,
        )
        await expect(rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), logger)).rejects.toThrow()
      })
    } finally {
      await holder.end()
    }

    // O tenant nunca fica sem chave utilizável nem com estado parcial.
    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyId).toBe('key-old')
    expect(rows[0]!.active).toBe(true)
  })

  it('o lock_timeout vale para a aquisição do advisory lock (não espera indefinidamente)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-advisory-locked' })
    const oldKey = createTestCredentialSigningKey('key-old')
    const newKey = createTestCredentialSigningKey('key-new')
    await createIssuerSigningKey(adminPool.db, tenantId, oldKey)

    // Outra "rotação" já está com o lock do tenant. O timeout é definido ANTES
    // do advisory lock, então esta chamada precisa desistir em ~3s.
    const holder = createDbPool(db.adminUrl, { max: 1 })
    try {
      await holder.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'comprova-signing-key-rotate:' + tenantId}))`,
        )
        const startedAt = Date.now()
        const failure = await rotateSigningKey(adminPool.db, entryOf(tenantId, newKey), logger).catch(
          (error: unknown) => error,
        )
        expect(Date.now() - startedAt).toBeLessThan(5_000)
        // O driver embrulha o erro; a causa é o cancelamento por lock timeout.
        const causeMessage = (failure as { cause?: { message?: string } }).cause?.message ?? ''
        expect(causeMessage).toMatch(/lock timeout/i)
      })
    } finally {
      await holder.end()
    }

    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyId).toBe('key-old')
    expect(rows[0]!.active).toBe(true)
  })

  it('duas rotações concorrentes não produzem duas chaves ativas', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-concurrent' })
    const keyA = createTestCredentialSigningKey('key-a')
    const keyB = createTestCredentialSigningKey('key-b')
    const keyC = createTestCredentialSigningKey('key-c')
    await createIssuerSigningKey(adminPool.db, tenantId, keyA)

    const [first, second] = await Promise.all([
      rotateSigningKey(adminPool.db, entryOf(tenantId, keyB), logger),
      rotateSigningKey(adminPool.db, entryOf(tenantId, keyC), logger),
    ])

    // O lock por tenant serializa: uma rotação enxerga o resultado da outra.
    expect(new Set([first.status, second.status])).toEqual(new Set(['rotated']))
    const rows = await rowsOf(tenantId)
    expect(rows.filter((row) => row.active)).toHaveLength(1)
    expect(rows).toHaveLength(3)
  })

  it('rotação de um tenant não altera as chaves de outro (isolamento)', async () => {
    const tenantA = await createTenant(adminPool.db, { name: 'rotation-tenant-a' })
    const tenantB = await createTenant(adminPool.db, { name: 'rotation-tenant-b' })
    const aOld = createTestCredentialSigningKey('key-a-old')
    const aNew = createTestCredentialSigningKey('key-a-new')
    const bKey = createTestCredentialSigningKey('key-b-old')
    await createIssuerSigningKey(adminPool.db, tenantA, aOld)
    await createIssuerSigningKey(adminPool.db, tenantB, bKey)

    await rotateSigningKey(adminPool.db, entryOf(tenantA, aNew), logger)

    const bRows = await rowsOf(tenantB)
    expect(bRows).toHaveLength(1)
    expect(bRows[0]!.keyId).toBe('key-b-old')
    expect(bRows[0]!.active).toBe(true)
    expect(await loadActiveSigningKey(adminPool.db, tenantB)).toMatchObject({ keyId: 'key-b-old' })

    expect((await activeRowsOf(tenantA)).map((row) => row.keyId)).toEqual(['key-a-new'])
  })

  it('tenant sem chave ativa recebe a primeira chave (previousKeyId null)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'rotation-bootstrap' })
    const key = createTestCredentialSigningKey('key-first')

    const outcome = await rotateSigningKey(adminPool.db, entryOf(tenantId, key), logger)

    expect(outcome).toEqual({
      tenantId,
      keyId: 'key-first',
      previousKeyId: null,
      status: 'rotated',
    })
    expect((await activeRowsOf(tenantId)).map((row) => row.keyId)).toEqual(['key-first'])
  })
})
