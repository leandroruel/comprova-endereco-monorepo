import { generateKeyPairSync } from 'node:crypto'
import { ed25519PublicKeyBytes } from '@comprova/credential'
import { describe, expect, it } from 'vitest'
import { makeSigningKeyProvider } from '../../src/services/signing-key-provider.factory.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const KEY_ID = 'key-1'

const publicKey = (): Buffer => {
  const { publicKey } = generateKeyPairSync('ed25519')
  return ed25519PublicKeyBytes(publicKey)
}

describe('makeSigningKeyProvider', () => {
  it('local (default) usa CREDENTIAL_SIGNING_KEYS sem instanciar o backend KMS', async () => {
    const provider = await makeSigningKeyProvider({
      SIGNING_KEY_PROVIDER: 'local',
      CREDENTIAL_SIGNING_KEYS: '[]',
    })

    await expect(
      provider.signerFor({
        tenantId: TENANT,
        keyId: KEY_ID,
        publicKey: publicKey(),
        kmsKeyReference: null,
      }),
    ).rejects.toMatchObject({ failure: 'SIGNING_KEY_UNAVAILABLE' })
  })

  it('aws-kms seleciona o provider KMS e recusa uma chave sem referência externa', async () => {
    const provider = await makeSigningKeyProvider({
      SIGNING_KEY_PROVIDER: 'aws-kms',
      CREDENTIAL_SIGNING_KEYS: '[]',
      AWS_KMS_REGION: 'sa-east-1',
    })

    await expect(
      provider.signerFor({
        tenantId: TENANT,
        keyId: KEY_ID,
        publicKey: publicKey(),
        kmsKeyReference: null,
      }),
    ).rejects.toMatchObject({ failure: 'SIGNING_KEY_UNAVAILABLE' })
  })
})
