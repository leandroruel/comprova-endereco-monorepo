import { createPrivateKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from 'node:crypto'

/**
 * Assinador mínimo (FASE 8): sua única responsabilidade é assinar bytes. Não
 * conhece issuer, storage, VC nem banco. Implementação de desenvolvimento:
 * Ed25519 via `node:crypto` (sem dependência nova).
 */
export interface Signer {
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

export interface Ed25519KeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
}

export const generateEd25519KeyPair = (): Ed25519KeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey, privateKey }
}

export const makeEd25519Signer = (privateKey: KeyObject): Signer => ({
  sign: async (bytes) => ed25519Sign(null, bytes, privateKey),
})

export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyError'
  }
}

/**
 * Lê a chave privada de assinatura no formato padrão PKCS#8 PEM (o que
 * `openssl genpkey -algorithm ED25519` produz; nada proprietário) e garante que
 * ela é Ed25519. A aplicação chama isto no boot: configuração inválida falha
 * fechado, antes de aceitar tráfego. A chave é um `KeyObject` em memória; a
 * biblioteca não lê ambiente nem guarda segredo.
 *
 * Aceita o PEM com quebras de linha reais (uso programático/testes) ou com
 * `\n` escapado (o formato que aparece em arquivos de ambiente de linha única).
 */
export const ed25519PrivateKeyFromPkcs8Pem = (value: string): KeyObject => {
  const pem = value.includes('\\n') && !value.includes('\n') ? value.replaceAll('\\n', '\n') : value
  const privateKey = ((): KeyObject => {
    try {
      return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })
    } catch (error) {
      throw new SigningKeyError(
        `signing key is not a valid PKCS#8 PEM: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new SigningKeyError(
      `signing key must be Ed25519 (got ${privateKey.asymmetricKeyType ?? 'unknown'})`,
    )
  }
  return privateKey
}
