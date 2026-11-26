/**
 * Interface mínima para assinatura de credenciais.
 * Definida aqui para evitar dependência circular entre core e credential.
 */
export interface Signer {
  sign(bytes: Uint8Array): Promise<Uint8Array>
}

/**
 * Tipo para o provider de assinatura por tenant.
 * Implementado no pacote API (`@comprova/api/services/signing-key-provider.ts`).
 */
export interface SigningKeyProvider {
  signerFor(request: SigningKeyRequest): Promise<Signer>
}

export interface SigningKeyRequest {
  readonly tenantId: string
  readonly keyId: string
  readonly publicKey: Uint8Array
  readonly kmsKeyReference: string | null
}

/**
 * Configuração do issuer de credencial resolvida no boot.
 * Usada tanto pelo worker (emissão automática) quanto pela API (emissão manual).
 */
export interface CredentialIssuerDeps {
  /**
   * Origem HTTPS controlada pelo projeto (`CREDENTIAL_ISSUER_ORIGIN`).
   * O `id` do issuer é derivado dela + tenant.
   */
  readonly issuerOrigin: string
  /**
   * Provider de assinatura por (`tenant_id`, `key_id`).
   * Resolve o material da chave JÁ SELECIONADA e devolve um `Signer`.
   */
  readonly signingKeyProvider: SigningKeyProvider
  /**
   * Horizonte da CREDENCIAL em segundos (`policy.credential_ttl_seconds`).
   * Omitido = 30 dias.
   */
  readonly credentialTtlSeconds?: number
}