import {
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto'
import type { SignCommandInput } from '@aws-sdk/client-kms'
import { ed25519PublicKeyBytes } from '@comprova/credential'
import { describe, expect, it, vi } from 'vitest'
import {
  makeAwsKmsSigner,
  makeAwsKmsSigningKeyProvider,
  readAwsKmsPublicKey,
  type AwsKmsSigner,
} from '../../src/services/aws-kms-signing-key-provider.js'
import type { SigningKeyRequest } from '../../src/services/signing-key-provider.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const KEY_ID = 'key-1'
const KMS_REFERENCE = 'arn:aws:kms:sa-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'

interface TestKey {
  readonly privateKey: KeyObject
  readonly publicKeyObject: KeyObject
  /** 32 bytes crus — o formato publicado em `issuer_signing_key.public_key`. */
  readonly publicKey: Buffer
}

const testKey = (): TestKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKeyObject: publicKey,
    publicKey: ed25519PublicKeyBytes(publicKey),
  }
}

const request = (publicKey: Uint8Array, kmsKeyReference: string | null): SigningKeyRequest => ({
  tenantId: TENANT,
  keyId: KEY_ID,
  publicKey,
  kmsKeyReference,
})

const signerFor = (key: TestKey, onSign?: (keyReference: string) => void): AwsKmsSigner => ({
  sign: async ({ keyReference, message }) => {
    onSign?.(keyReference)
    return ed25519Sign(null, message, key.privateKey)
  },
})

describe('makeAwsKmsSigningKeyProvider', () => {
  it('assina no KMS e a assinatura verifica com a pública publicada no banco', async () => {
    const key = testKey()
    const provider = makeAwsKmsSigningKeyProvider(signerFor(key))
    const signer = await provider.signerFor(request(key.publicKey, KMS_REFERENCE))
    const input = Buffer.from('hashData do eddsa-jcs-2022', 'utf8')

    const signature = await signer.sign(input)

    expect(ed25519Verify(null, input, key.publicKeyObject, signature)).toBe(true)
  })

  it('sem kms_key_reference falha fechado e nunca chama o KMS', async () => {
    const key = testKey()
    const onSign = vi.fn()
    const provider = makeAwsKmsSigningKeyProvider(signerFor(key, onSign))

    await expect(provider.signerFor(request(key.publicKey, null))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_UNAVAILABLE',
    })
    await expect(provider.signerFor(request(key.publicKey, '   '))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_UNAVAILABLE',
    })
    expect(onSign).not.toHaveBeenCalled()
  })

  it('assinatura de outra chave KMS não corresponde à pública publicada → MISMATCH', async () => {
    const published = testKey()
    const kmsKey = testKey()
    const provider = makeAwsKmsSigningKeyProvider(signerFor(kmsKey))
    const signer = await provider.signerFor(request(published.publicKey, KMS_REFERENCE))

    await expect(signer.sign(Buffer.from('payload', 'utf8'))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_MISMATCH',
    })
  })

  it('falha do KMS vira SIGNING_KEY_UNAVAILABLE (não vaza erro cru)', async () => {
    const key = testKey()
    const provider = makeAwsKmsSigningKeyProvider({
      sign: async () => {
        throw new Error('KMS is unavailable')
      },
    })
    const signer = await provider.signerFor(request(key.publicKey, KMS_REFERENCE))

    await expect(signer.sign(Buffer.from('payload', 'utf8'))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_UNAVAILABLE',
    })
  })

  it('pública publicada inválida falha antes de chamar o KMS', async () => {
    const onSign = vi.fn()
    const key = testKey()
    const provider = makeAwsKmsSigningKeyProvider(signerFor(key, onSign))

    await expect(provider.signerFor(request(Buffer.alloc(31), KMS_REFERENCE))).rejects.toMatchObject({
      failure: 'SIGNING_KEY_MISMATCH',
    })
    expect(onSign).not.toHaveBeenCalled()
  })
})

describe('makeAwsKmsSigner', () => {
  it('envia MessageType RAW + ED25519_SHA_512 (Pure EdDSA, compatível com eddsa-jcs-2022)', async () => {
    const key = testKey()
    const input = Buffer.from('mensagem', 'utf8')
    const send = vi.fn(async (command: SignCommandInput) => {
      expect(command).toMatchObject({
        KeyId: KMS_REFERENCE,
        MessageType: 'RAW',
        SigningAlgorithm: 'ED25519_SHA_512',
      })
      expect(Buffer.from(command.Message ?? [])).toEqual(input)
      return { Signature: ed25519Sign(null, command.Message!, key.privateKey) }
    })

    const signature = await makeAwsKmsSigner(send).sign({
      keyReference: KMS_REFERENCE,
      message: input,
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(ed25519Verify(null, input, key.publicKeyObject, signature)).toBe(true)
  })

  it('recusa resposta do KMS sem assinatura', async () => {
    const signer = makeAwsKmsSigner(async () => ({}))

    await expect(signer.sign({ keyReference: KMS_REFERENCE, message: new Uint8Array() })).rejects.toThrow(
      /no signature/,
    )
  })
})

describe('readAwsKmsPublicKey', () => {
  it('devolve o ARN canônico e os 32 bytes crus da Ed25519', async () => {
    const key = testKey()
    const der = key.publicKeyObject.export({ format: 'der', type: 'spki' })
    const canonicalReference = 'arn:aws:kms:sa-east-1:111122223333:key/canonical'
    const send = vi.fn(async () => ({
      KeyId: canonicalReference,
      PublicKey: der,
      KeySpec: 'ECC_NIST_EDWARDS25519' as const,
      KeyUsage: 'SIGN_VERIFY' as const,
    }))

    const result = await readAwsKmsPublicKey(send, 'alias/comprova')

    expect(send).toHaveBeenCalledWith({ KeyId: 'alias/comprova' })
    expect(result.keyReference).toBe(canonicalReference)
    expect(result.publicKey.equals(key.publicKey)).toBe(true)
  })

  it('recusa chave KMS que não seja Ed25519', async () => {
    const key = testKey()
    const der = key.publicKeyObject.export({ format: 'der', type: 'spki' })

    await expect(
      readAwsKmsPublicKey(
        async () => ({
          KeyId: 'arn:aws:kms:sa-east-1:111122223333:key/p256',
          PublicKey: der,
          KeySpec: 'ECC_NIST_P256',
          KeyUsage: 'SIGN_VERIFY',
        }),
        KMS_REFERENCE,
      ),
    ).rejects.toThrow(/ECC_NIST_EDWARDS25519/)
  })

  it('recusa chave KMS sem KeyUsage SIGN_VERIFY', async () => {
    const key = testKey()
    const der = key.publicKeyObject.export({ format: 'der', type: 'spki' })

    await expect(
      readAwsKmsPublicKey(
        async () => ({
          KeyId: KMS_REFERENCE,
          PublicKey: der,
          KeySpec: 'ECC_NIST_EDWARDS25519',
          KeyUsage: 'ENCRYPT_DECRYPT',
        }),
        KMS_REFERENCE,
      ),
    ).rejects.toThrow(/SIGN_VERIFY/)
  })

  it('recusa resposta sem pública ou sem identificador', async () => {
    await expect(readAwsKmsPublicKey(async () => ({}), KMS_REFERENCE)).rejects.toThrow(
      /no public key or key identifier/,
    )
  })
})
