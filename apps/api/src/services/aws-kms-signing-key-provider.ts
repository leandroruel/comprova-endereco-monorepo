import { createPublicKey, verify as ed25519Verify, type KeyObject } from 'node:crypto'
import type {
  GetPublicKeyCommandInput,
  GetPublicKeyCommandOutput,
  SignCommandInput,
  SignCommandOutput,
} from '@aws-sdk/client-kms'
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { ed25519PublicKeyBytes, ed25519PublicKeyFromBytes } from '@comprova/credential'
import {
  SigningKeyProviderError,
  type SigningKeyProvider,
  type SigningKeyRequest,
} from './signing-key-provider.js'

/**
 * Backend de assinatura AWS KMS (roadmap #24, etapa 24.3; ADR-0032).
 *
 * O princípio central é que o KMS ASSINA, não entrega a chave privada:
 *
 *   API ──(bytes)──▶ AWS KMS ──(assinatura)──▶ API
 *
 * A privada nunca chega à memória da aplicação. O issuer continua vendo apenas
 * `Signer.sign(bytes)`, exatamente como no backend local.
 *
 * Compatibilidade criptográfica: o projeto usa Ed25519 puro (`eddsa-jcs-2022`
 * assina `hashData` com Pure EdDSA). O AWS KMS suporta essa combinação com
 * `KeySpec=ECC_NIST_EDWARDS25519`, `SigningAlgorithm=ED25519_SHA_512` e
 * `MessageType=RAW`. NÃO usar `ED25519_PH_SHA_512`/`MessageType=DIGEST`: é
 * HashEdDSA (prehash), produziria uma assinatura que o verificador Pure EdDSA
 * do projeto rejeita. O tipo do input abaixo fixa os dois valores.
 *
 * A pública continua vindo do banco (`issuer_signing_key.public_key`) e a
 * verificação pública não consulta a AWS. Depois de cada `Sign`, conferimos
 * localmente que a assinatura valida com essa pública: uma referência KMS
 * trocada/errada falha fechado como `SIGNING_KEY_MISMATCH`, em vez de emitir
 * uma credencial que o verificador não resolve.
 */

/** Porta mínima de assinatura: testável sem AWS e sem expor a privada. */
export interface AwsKmsSigner {
  readonly sign: (input: {
    readonly keyReference: string
    readonly message: Uint8Array
  }) => Promise<Uint8Array>
}

/** Envia `Sign`; o teste injeta um fake, a produção injeta `KMSClient.send`. */
export type AwsKmsSignSend = (input: SignCommandInput) => Promise<Pick<SignCommandOutput, 'Signature'>>

/** Envia `GetPublicKey` (só provisionamento/rotação). */
export type AwsKmsPublicKeySend = (
  input: GetPublicKeyCommandInput,
) => Promise<Pick<GetPublicKeyCommandOutput, 'KeyId' | 'PublicKey' | 'KeySpec' | 'KeyUsage'>>

export interface AwsKmsPublicKey {
  /** ARN canônico devolvido pelo KMS (nunca o alias de entrada). */
  readonly keyReference: string
  /** 32 bytes crus da Ed25519 — o formato de `issuer_signing_key.public_key`. */
  readonly publicKey: Buffer
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const verifyOrFalse = (message: Uint8Array, publicKey: KeyObject, signature: Uint8Array): boolean => {
  try {
    return ed25519Verify(null, message, publicKey, signature)
  } catch {
    // Assinatura com tamanho/formato inválido: falha fechado, não propaga erro
    // cru do `node:crypto` (a tradução para o domínio é do provider).
    return false
  }
}

/**
 * Adapta o envio de `Sign` ao algoritmo do projeto. Os dois valores são
 * deliberadamente literais: mudar para `ED25519_PH_SHA_512`/`DIGEST` quebraria
 * `eddsa-jcs-2022`, e os testes fixam explicitamente `RAW`/`ED25519_SHA_512`.
 */
export const makeAwsKmsSigner = (send: AwsKmsSignSend): AwsKmsSigner => ({
  sign: async ({ keyReference, message }) => {
    const output = await send({
      KeyId: keyReference,
      Message: message,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    })
    if (output.Signature === undefined) {
      throw new Error('AWS KMS Sign returned no signature')
    }
    return output.Signature
  },
})

/**
 * Lê a pública de uma chave KMS Ed25519. Usado SÓ no provisionamento/rotação:
 * a emissão não chama `GetPublicKey`, e a verificação pública não chama a AWS.
 *
 * O `KeyId` de retorno é o ARN canônico. Gravamos o ARN (e não o alias/ID de
 * entrada) em `kms_key_reference`: um alias pode ser repontado depois, o que
 * trocaria silenciosamente a chave que assina; o trigger da migration 0038
 * congela a referência publicada.
 */
export const readAwsKmsPublicKey = async (
  send: AwsKmsPublicKeySend,
  keyReference: string,
): Promise<AwsKmsPublicKey> => {
  const output = await send({ KeyId: keyReference })
  if (output.PublicKey === undefined || output.KeyId === undefined) {
    throw new Error('AWS KMS GetPublicKey returned no public key or key identifier')
  }
  if (output.KeySpec !== undefined && output.KeySpec !== 'ECC_NIST_EDWARDS25519') {
    throw new Error(
      `AWS KMS key must be ECC_NIST_EDWARDS25519 (got ${output.KeySpec}); eddsa-jcs-2022 requires Ed25519`,
    )
  }
  if (output.KeyUsage !== undefined && output.KeyUsage !== 'SIGN_VERIFY') {
    throw new Error(`AWS KMS key must have KeyUsage SIGN_VERIFY (got ${output.KeyUsage})`)
  }
  const publicKeyObject = createPublicKey({
    key: Buffer.from(output.PublicKey),
    format: 'der',
    type: 'spki',
  })
  return {
    keyReference: output.KeyId,
    publicKey: ed25519PublicKeyBytes(publicKeyObject),
  }
}

/**
 * Implementação `SigningKeyProvider` sobre AWS KMS.
 *
 * Recebe a chave JÁ SELECIONADA pelo domínio (tenant + key_id + pública
 * publicada). Não decide lifecycle, não consulta o banco e não tem fallback
 * global: sem `kms_key_reference` a emissão falha fechado.
 */
export const makeAwsKmsSigningKeyProvider = (kms: AwsKmsSigner): SigningKeyProvider => ({
  signerFor: async ({ tenantId, keyId, publicKey, kmsKeyReference }: SigningKeyRequest) => {
    if (kmsKeyReference === null || kmsKeyReference.trim() === '') {
      throw new SigningKeyProviderError(
        'SIGNING_KEY_UNAVAILABLE',
        `active signing key for tenant ${tenantId} key ${keyId} has no AWS KMS reference; refusing to sign`,
      )
    }

    const publishedPublicKey = ((): KeyObject => {
      try {
        return ed25519PublicKeyFromBytes(publicKey)
      } catch (error) {
        throw new SigningKeyProviderError(
          'SIGNING_KEY_MISMATCH',
          `published public key for tenant ${tenantId} key ${keyId} is not a valid Ed25519 key: ${describeError(error)}`,
        )
      }
    })()

    return {
      sign: async (message) => {
        let signed: Uint8Array
        try {
          signed = await kms.sign({ keyReference: kmsKeyReference, message })
        } catch (error) {
          throw new SigningKeyProviderError(
            'SIGNING_KEY_UNAVAILABLE',
            `AWS KMS signing failed for tenant ${tenantId} key ${keyId}: ${describeError(error)}`,
          )
        }

        if (!verifyOrFalse(message, publishedPublicKey, signed)) {
          throw new SigningKeyProviderError(
            'SIGNING_KEY_MISMATCH',
            `AWS KMS signature for tenant ${tenantId} key ${keyId} does not verify against the published public key`,
          )
        }
        return signed
      },
    }
  },
})

/**
 * Timeouts do cliente KMS. A emissão de credencial NÃO pode ficar pendurada
 * numa chamada de rede: por padrão o SDK não tem `requestTimeout` efetivo (só
 * emite warning) e tenta várias vezes, o que estenderia a espera. Aqui a
 * chamada falha em ~2s para conectar / 5s para request+resposta, com no máximo
 * 2 tentativas, e `throwOnRequestTimeout` garante que o estouro vire
 * `TimeoutError` em vez de warning. O provider traduz para
 * `SIGNING_KEY_UNAVAILABLE` (fail closed; sem fallback para o backend local).
 */
const KMS_REQUEST_HANDLER = {
  connectionTimeout: 2_000,
  requestTimeout: 5_000,
  throwOnRequestTimeout: true,
} as const

/** Cliente KMS real; região ausente deixa o SDK usar `AWS_REGION`/default chain. */
export const makeAwsKmsClient = (region?: string): KMSClient =>
  new KMSClient({
    ...(region === undefined ? {} : { region }),
    requestHandler: KMS_REQUEST_HANDLER,
    maxAttempts: 2,
  })

export const awsKmsSignerFromClient = (client: KMSClient): AwsKmsSigner =>
  makeAwsKmsSigner((input) => client.send(new SignCommand(input)))

export const readAwsKmsPublicKeyFromClient = (
  client: KMSClient,
  keyReference: string,
): Promise<AwsKmsPublicKey> =>
  readAwsKmsPublicKey((input) => client.send(new GetPublicKeyCommand(input)), keyReference)

/**
 * Constrói o provider a partir da configuração. Chamado só quando
 * `SIGNING_KEY_PROVIDER=aws-kms`; o backend local não instancia cliente AWS.
 */
export const makeAwsKmsSigningKeyProviderFromConfig = (region?: string): SigningKeyProvider =>
  makeAwsKmsSigningKeyProvider(awsKmsSignerFromClient(makeAwsKmsClient(region)))
