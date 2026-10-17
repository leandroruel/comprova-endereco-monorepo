/**
 * Identidade mínima do issuer (FASE 7). Não é DID, não há resolução nem
 * rotação de chave: `id` é um identificador estável derivado do tenant e
 * `keyId` referencia a chave usada para assinar. Trocar `localIssuer` por uma
 * implementação DID futura não deve exigir mudar a construção da assertion.
 */
export interface IssuerIdentity {
  readonly id: string
  readonly keyId: string
}

/** `issuer.id` estável para um tenant: `comprova:issuer:<tenant_id>`. */
export const issuerIdOf = (tenantId: string): string => `comprova:issuer:${tenantId}`

export const localIssuer = (tenantId: string, keyId: string): IssuerIdentity => ({
  id: issuerIdOf(tenantId),
  keyId,
})
