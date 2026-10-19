import { generateKeyPairSync, type KeyObject } from 'node:crypto'

/**
 * Par de chaves Ed25519 efêmero para a configuração de emissão (`CREDENTIAL_
 * SIGNING_*`). Nenhuma chave privada literal vive no repositório: cada teste
 * cria a sua em memória e a API a lê no boot, como faria com a configuração real.
 */
export interface TestCredentialSigningKey {
  readonly keyId: string
  /** PKCS#8 PEM — o mesmo formato aceito por `CREDENTIAL_SIGNING_PRIVATE_KEY`. */
  readonly privateKeyPkcs8Pem: string
  /** Chave pública correspondente, para o consumidor/verificador de teste. */
  readonly publicKey: KeyObject
}

export const createTestCredentialSigningKey = (keyId = 'key-1'): TestCredentialSigningKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    keyId,
    privateKeyPkcs8Pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey,
  }
}
