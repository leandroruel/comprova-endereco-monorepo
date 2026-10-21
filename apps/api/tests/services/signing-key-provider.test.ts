import { generateKeyPairSync, verify as ed25519Verify, type KeyObject } from 'node:crypto'
import { ed25519PublicKeyBytes } from '@comprova/credential'
import { describe, expect, it } from 'vitest'
import {
  makeConfiguredSigningKeyProvider,
  SigningKeyProviderError,
  type SigningKeyRequest,
} from '../../src/services/signing-key-provider.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const KEY_ID = 'key-1'

interface TestSigningKey {
  readonly pem: string
  /** 32 bytes crus — o mesmo formato de `issuer_signing_key.public_key`. */
  readonly publicKey: Buffer
  readonly publicKeyObject: KeyObject
}

const testSigningKey = (): TestSigningKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: ed25519PublicKeyBytes(publicKey),
    publicKeyObject: publicKey,
  }
}

const providerFor = (entries: readonly { tenantId: string; keyId: string; pem: string }[]) =>
  makeConfiguredSigningKeyProvider(
    JSON.stringify(
      entries.map((entry) => ({
        tenant_id: entry.tenantId,
        key_id: entry.keyId,
        private_key_pem: entry.pem,
      })),
    ),
  )

const request = (tenantId: string, keyId: string, publicKey: Uint8Array): SigningKeyRequest => ({
  tenantId,
  keyId,
  publicKey,
  kmsKeyReference: null,
})

describe('makeConfiguredSigningKeyProvider', () => {
  it('assina os bytes com a chave configurada; a assinatura verifica com a pública publicada', async () => {
    const key = testSigningKey()
    const provider = providerFor([{ tenantId: TENANT, keyId: KEY_ID, pem: key.pem }])
    const signer = await provider.signerFor(request(TENANT, KEY_ID, key.publicKey))
    const input = Buffer.from('payload a assinar', 'utf8')

    const signature = await signer.sign(input)

    expect(ed25519Verify(null, input, key.publicKeyObject, signature)).toBe(true)
  })

  it('sem material para (tenant, key_id) falha fechado — nunca cai numa chave global', async () => {
    const key = testSigningKey()
    const other = testSigningKey()
    const provider = providerFor([{ tenantId: TENANT, keyId: KEY_ID, pem: key.pem }])

    // Mesmo tenant, outro key_id.
    await expect(provider.signerFor(request(TENANT, 'key-2', key.publicKey))).rejects.toBeInstanceOf(
      SigningKeyProviderError,
    )
    // Outro tenant, mesmo key_id: o key_id sozinho não resolve nada.
    await expect(provider.signerFor(request(OTHER, KEY_ID, other.publicKey))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_UNAVAILABLE',
    })
  })

  it('não assina no backend local uma chave marcada como KMS (sem fallback cruzado)', async () => {
    const key = testSigningKey()
    const provider = providerFor([{ tenantId: TENANT, keyId: KEY_ID, pem: key.pem }])

    await expect(
      provider.signerFor({
        ...request(TENANT, KEY_ID, key.publicKey),
        kmsKeyReference: 'arn:aws:kms:sa-east-1:111122223333:key/1234',
      }),
    ).rejects.toMatchObject({ failure: 'SIGNING_KEY_UNAVAILABLE' })
  })

  it('material privado que não corresponde à pública publicada é recusado', async () => {
    const configured = testSigningKey()
    const published = testSigningKey()
    const provider = providerFor([{ tenantId: TENANT, keyId: KEY_ID, pem: configured.pem }])

    await expect(provider.signerFor(request(TENANT, KEY_ID, published.publicKey))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_MISMATCH',
    })
  })

  it('isola tenants: o material de A não é alcançado no contexto de B', async () => {
    const a = testSigningKey()
    const provider = providerFor([{ tenantId: TENANT, keyId: KEY_ID, pem: a.pem }])

    // Contexto de B, MESMO key_id e a pública de A: não há material para B.
    await expect(provider.signerFor(request(OTHER, KEY_ID, a.publicKey))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_UNAVAILABLE',
    })

    // Cada tenant assina com a própria chave, mesmo com o key_id repetido.
    const b = testSigningKey()
    const both = providerFor([
      { tenantId: TENANT, keyId: KEY_ID, pem: a.pem },
      { tenantId: OTHER, keyId: KEY_ID, pem: b.pem },
    ])
    const input = Buffer.from('mesmo key_id, tenants diferentes', 'utf8')
    const signatureA = await (await both.signerFor(request(TENANT, KEY_ID, a.publicKey))).sign(input)
    const signatureB = await (await both.signerFor(request(OTHER, KEY_ID, b.publicKey))).sign(input)

    expect(ed25519Verify(null, input, a.publicKeyObject, signatureA)).toBe(true)
    expect(ed25519Verify(null, input, b.publicKeyObject, signatureB)).toBe(true)
    // A assinatura de A NÃO valida com a pública de B.
    expect(ed25519Verify(null, input, b.publicKeyObject, signatureA)).toBe(false)
  })

  it('é determinístico (Ed25519): mesmos bytes e mesma chave produzem a mesma assinatura', async () => {
    const key = testSigningKey()
    const provider = providerFor([{ tenantId: TENANT, keyId: KEY_ID, pem: key.pem }])
    const input = Buffer.from('payload determinístico', 'utf8')

    const first = await (await provider.signerFor(request(TENANT, KEY_ID, key.publicKey))).sign(input)
    const second = await (await provider.signerFor(request(TENANT, KEY_ID, key.publicKey))).sign(input)

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
  })

  it('configuração inválida falha no boot, não só na primeira assinatura', () => {
    expect(() => makeConfiguredSigningKeyProvider('nope')).toThrow()
  })
})
