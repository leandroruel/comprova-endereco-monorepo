import { ed25519PublicKeyBytes, issuerScopeOf } from '@comprova/credential'
import * as t from '@comprova/db'
import { and, createDbPool, eq, runMigrations } from '@comprova/db'
import { createLogger } from '@comprova/observability'
import {
  createTenant,
  createTestCredentialSigningKey,
  signingKeysConfig,
  startTestDb,
  TEST_APP_DB_PASSWORD,
  type TestCredentialSigningKey,
} from '@comprova/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { loadActiveSigningKey } from './credential-issuer.js'
import { provisionSigningKeys, SigningKeyProvisioningError } from './provision-signing-keys.js'
import { parseSigningKeys, type SigningKeyEntry } from './signing-keys.js'

// FASE 14 — provisionamento da chave publicada. Garante as duas invariantes que
// o startup depende: (1) uma chave publicada nunca é sobrescrita e (2) a chave
// ativa do tenant é preservada (adicionar `key_id` não colide no índice parcial
// único nem troca quem assina).

const logger = createLogger({ level: 'silent' })

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)

afterAll(async () => {
  await adminPool.end()
  await db.stop()
})

/** Entradas como o boot as veria: o JSON de config passa pelo mesmo parser. */
const entriesOf = (tenantId: string, keys: readonly TestCredentialSigningKey[]): readonly SigningKeyEntry[] =>
  parseSigningKeys(signingKeysConfig(keys.map((key) => ({ tenantId, key }))))

/** Entrada KMS com a pública já resolvida, como o CLI a monta após GetPublicKey. */
const entryOfKms = (
  key: TestCredentialSigningKey,
  tenantId: string,
  kmsKeyReference: string,
): SigningKeyEntry => ({
  kind: 'kms',
  tenantId,
  keyId: key.keyId,
  kmsKeyReference,
  publicKey: ed25519PublicKeyBytes(key.publicKey),
})

const rowsOf = async (tenantId: string) =>
  adminPool.db.select().from(t.issuerSigningKey).where(eq(t.issuerSigningKey.tenantId, tenantId))

describe('provisionSigningKeys', () => {
  it('publica a primeira chave como ativa e é idempotente ao repetir', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-idempotent' })
    const key = createTestCredentialSigningKey('key-1')
    const entries = entriesOf(tenantId, [key])

    const first = await provisionSigningKeys(adminPool.db, entries, logger)
    expect(first).toEqual([{ tenantId, keyId: 'key-1', status: 'published', active: true }])

    const again = await provisionSigningKeys(adminPool.db, entries, logger)
    expect(again).toEqual([{ tenantId, keyId: 'key-1', status: 'unchanged', active: true }])

    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.active).toBe(true)
    expect(rows[0]!.algorithm).toBe('Ed25519')
    expect(rows[0]!.issuerScope).toBe(issuerScopeOf(tenantId))
    expect(Buffer.from(rows[0]!.publicKey).equals(ed25519PublicKeyBytes(key.publicKey))).toBe(true)
  })

  it('recusa sobrescrever uma chave publicada e mantém a chave antiga intacta', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-no-overwrite' })
    const original = createTestCredentialSigningKey('key-1')
    await provisionSigningKeys(adminPool.db, entriesOf(tenantId, [original]), logger)

    // Mesmo `key_id`, material NOVO: falha alto, não substitui a publicada.
    const replacement = createTestCredentialSigningKey('key-1')
    await expect(
      provisionSigningKeys(adminPool.db, entriesOf(tenantId, [replacement]), logger),
    ).rejects.toBeInstanceOf(SigningKeyProvisioningError)

    const rows = await rowsOf(tenantId)
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]!.publicKey).equals(ed25519PublicKeyBytes(original.publicKey))).toBe(true)

    // O caminho certo: publicar sob um `key_id` NOVO (a antiga continua ativa).
    const published = await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-2')]),
      logger,
    )
    expect(published).toEqual([{ tenantId, keyId: 'key-2', status: 'published', active: false }])
    const stillPublished = await rowsOf(tenantId)
    expect(stillPublished).toHaveLength(2)
    expect(
      Buffer.from(stillPublished.find((row) => row.keyId === 'key-1')!.publicKey).equals(
        ed25519PublicKeyBytes(original.publicKey),
      ),
    ).toBe(true)
  })

  it('a chave nova de um tenant que já tem ativa entra inativa (preserva quem assina)', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-second-key' })
    await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-1')]),
      logger,
    )

    const second = await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-2')]),
      logger,
    )
    expect(second).toEqual([{ tenantId, keyId: 'key-2', status: 'published', active: false }])

    const active = (await rowsOf(tenantId)).filter((row) => row.active)
    expect(active).toHaveLength(1)
    expect(active[0]!.keyId).toBe('key-1')
  })

  it('ativa só a primeira chave quando várias entram na mesma execução', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-same-run' })
    const outcomes = await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-1'), createTestCredentialSigningKey('key-2')]),
      logger,
    )

    expect(outcomes).toEqual([
      { tenantId, keyId: 'key-1', status: 'published', active: true },
      { tenantId, keyId: 'key-2', status: 'published', active: false },
    ])
    const active = (await rowsOf(tenantId)).filter((row) => row.active)
    expect(active).toHaveLength(1)
    expect(active[0]!.keyId).toBe('key-1')
  })

  it('uma chave ativa revogada/vencida libera o índice para a próxima nascer ativa', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-revoked-active' })
    await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-1')]),
      logger,
    )
    // Revogação/expiração já efetiva: `active` continua true (o eixo de rotação
    // não é reescrito), mas a chave não é mais confiável.
    await adminPool.db
      .update(t.issuerSigningKey)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(t.issuerSigningKey.tenantId, tenantId), eq(t.issuerSigningKey.keyId, 'key-1')))

    const outcomes = await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-2')]),
      logger,
    )
    expect(outcomes).toEqual([{ tenantId, keyId: 'key-2', status: 'published', active: true }])

    const rows = await rowsOf(tenantId)
    const oldKey = rows.find((row) => row.keyId === 'key-1')!
    const newKey = rows.find((row) => row.keyId === 'key-2')!
    // A antiga é desativada (libera o índice parcial único), mas mantém a
    // revogação e a chave pública intactas no histórico.
    expect(oldKey.active).toBe(false)
    expect(oldKey.revokedAt).not.toBeNull()
    expect(newKey.active).toBe(true)
    expect(newKey.revokedAt).toBeNull()
  })

  it('chave ativa com expiração futura ainda preserva a próxima chave como inativa', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-scheduled-active' })
    await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-1')]),
      logger,
    )
    await adminPool.db
      .update(t.issuerSigningKey)
      .set({ revokedAt: new Date(Date.now() + 3_600_000) })
      .where(and(eq(t.issuerSigningKey.tenantId, tenantId), eq(t.issuerSigningKey.keyId, 'key-1')))

    const outcomes = await provisionSigningKeys(
      adminPool.db,
      entriesOf(tenantId, [createTestCredentialSigningKey('key-2')]),
      logger,
    )
    expect(outcomes).toEqual([{ tenantId, keyId: 'key-2', status: 'published', active: false }])
  })

  it('publica chaves de tenants diferentes independentemente (mesmo key_id, escopos distintos)', async () => {
    const tenantA = await createTenant(adminPool.db, { name: 'provision-a' })
    const tenantB = await createTenant(adminPool.db, { name: 'provision-b' })
    const entries: readonly SigningKeyEntry[] = [
      ...entriesOf(tenantA, [createTestCredentialSigningKey('key-1')]),
      ...entriesOf(tenantB, [createTestCredentialSigningKey('key-1')]),
    ]

    const outcomes = await provisionSigningKeys(adminPool.db, entries, logger)
    expect(outcomes.every((outcome) => outcome.active)).toBe(true)
    expect(await rowsOf(tenantA)).toHaveLength(1)
    expect(await rowsOf(tenantB)).toHaveLength(1)
    const scopeA = (await rowsOf(tenantA))[0]!.issuerScope
    const scopeB = (await rowsOf(tenantB))[0]!.issuerScope
    expect(scopeA).not.toBe(scopeB)
  })

  it('publica chave KMS: pública lida do KMS e referência externa persistida', async () => {
    const tenantId = await createTenant(adminPool.db, { name: 'provision-kms' })
    const key = createTestCredentialSigningKey('kms-key')
    const kmsKeyReference = 'arn:aws:kms:sa-east-1:111122223333:key/1234abcd'

    const outcomes = await provisionSigningKeys(
      adminPool.db,
      [entryOfKms(key, tenantId, kmsKeyReference)],
      logger,
    )

    expect(outcomes).toEqual([{ tenantId, keyId: 'kms-key', status: 'published', active: true }])
    const row = (await rowsOf(tenantId))[0]!
    expect(row.kmsKeyReference).toBe(kmsKeyReference)
    expect(Buffer.from(row.publicKey).equals(ed25519PublicKeyBytes(key.publicKey))).toBe(true)
    expect(await loadActiveSigningKey(adminPool.db, tenantId)).toMatchObject({
      keyId: 'kms-key',
      kmsKeyReference,
    })

    // Repetir com a MESMA referência é idempotente...
    await expect(
      provisionSigningKeys(adminPool.db, [entryOfKms(key, tenantId, kmsKeyReference)], logger),
    ).resolves.toEqual([{ tenantId, keyId: 'kms-key', status: 'unchanged', active: true }])

    // ...mas trocar o backend/referência da chave publicada é recusado.
    await expect(
      provisionSigningKeys(adminPool.db, [entryOfKms(key, tenantId, `${kmsKeyReference}-other`)], logger),
    ).rejects.toBeInstanceOf(SigningKeyProvisioningError)
  })
})
