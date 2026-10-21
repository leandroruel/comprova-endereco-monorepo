import { createPublicKey } from 'node:crypto'
import { ed25519PublicKeyBytes, makeEd25519Signer, type Signer } from '@comprova/credential'
import { makeSigningKeyResolver, type SigningKeyResolver } from './signing-keys.js'

/**
 * Fronteira entre "qual chave o tenant usa" e "assinar bytes" (roadmap #24).
 *
 * O domínio de emissão (`issueCredential`) só precisa de um `Signer` para a
 * chave JÁ SELECIONADA (tenant + `key_id` ativos, com a pública publicada em
 * `issuer_signing_key`). Onde o material privado vive — configuração local
 * (`CREDENTIAL_SIGNING_KEYS`), KMS ou HSM — é detalhe do provider: o issuer
 * nunca vê a privada nem o PEM.
 *
 * O provider NÃO decide qual chave é ativa. A seleção continua em
 * `loadActiveSigningKey` (RLS + eixo `active`/`revoked_at`); o provider recebe a
 * chave já escolhida e apenas resolve o material correspondente. A resolução é
 * sempre por (`tenant_id`, `key_id`) — o `key_id` sozinho nunca alcança a chave
 * de outro tenant, e não existe chave global de fallback.
 *
 * A resolução é assíncrona de propósito: um provider KMS/HSM futuro resolve a
 * chave por rede. Na implementação local ela é síncrona por dentro, mas a
 * fronteira já aceita um backend remoto sem refatorar o domínio (a assinatura
 * em si já era assíncrona: `Signer.sign` devolve `Promise`).
 */

/** Chave JÁ SELECIONADA pelo domínio, com a pública publicada para conferência. */
export interface SigningKeyRequest {
  readonly tenantId: string
  readonly keyId: string
  /**
   * 32 bytes crus da chave pública publicada em `issuer_signing_key`
   * (`public_key`). O provider confere que o material privado que ele resolve
   * corresponde a estes bytes: a credencial não pode sair assinada por uma
   * chave que o verificador não resolve.
   */
  readonly publicKey: Uint8Array
}

/** Falhas do provider, mapeadas para `CredentialIssuanceError` pelo domínio. */
export type SigningKeyProviderFailure = 'SIGNING_KEY_UNAVAILABLE' | 'SIGNING_KEY_MISMATCH'

export class SigningKeyProviderError extends Error {
  readonly failure: SigningKeyProviderFailure

  constructor(failure: SigningKeyProviderFailure, message: string) {
    super(message)
    this.name = 'SigningKeyProviderError'
    this.failure = failure
  }
}

export interface SigningKeyProvider {
  /**
   * Resolve o material da chave JÁ SELECIONADA e devolve um `Signer` ligado a
   * ela. Falha fechado (nunca cai numa chave global) quando:
   *  - não há material para (`tenantId`, `keyId`) → `SIGNING_KEY_UNAVAILABLE`;
   *  - o material resolvido não corresponde à pública publicada →
   *    `SIGNING_KEY_MISMATCH`.
   */
  readonly signerFor: (request: SigningKeyRequest) => Promise<Signer>
}

/**
 * Costura interna do provider local: dado um resolver `(tenant, key_id) →
 * KeyObject`, resolve o material, confere a correspondência com a pública
 * publicada e devolve o `Signer`. Não é exportada — o backend local é
 * construído por `makeConfiguredSigningKeyProvider`, e um KMS/HSM futuro
 * implementa `SigningKeyProvider` diretamente.
 */
const makeSigningKeyProvider = (resolve: SigningKeyResolver): SigningKeyProvider => ({
  signerFor: async ({ tenantId, keyId, publicKey }) => {
    const privateKey = resolve(tenantId, keyId)
    if (privateKey === null) {
      throw new SigningKeyProviderError(
        'SIGNING_KEY_UNAVAILABLE',
        `no signing material configured for tenant ${tenantId} key ${keyId}`,
      )
    }
    // A privada é validada como Ed25519 no boot (parse da configuração); aqui
    // derivamos a pública e exigimos que ela seja a MESMA publicada no banco.
    const derivedPublicKey = createPublicKey(privateKey)
    if (!ed25519PublicKeyBytes(derivedPublicKey).equals(Buffer.from(publicKey))) {
      throw new SigningKeyProviderError(
        'SIGNING_KEY_MISMATCH',
        `configured signing material for tenant ${tenantId} key ${keyId} does not match the published public key`,
      )
    }
    return makeEd25519Signer(privateKey)
  },
})

/**
 * Implementação ATUAL (roadmap #24): material privado em
 * `CREDENTIAL_SIGNING_KEYS`, lido no boot (JSON/PEM inválidos derrubam a API).
 * KMS/HSM serão outras implementações de `SigningKeyProvider`, sem mudar o
 * domínio de emissão.
 */
export const makeConfiguredSigningKeyProvider = (rawJson: string): SigningKeyProvider =>
  makeSigningKeyProvider(makeSigningKeyResolver(rawJson))
