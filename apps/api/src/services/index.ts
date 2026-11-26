export {
  CredentialIssuanceError,
  issueCredential,
  loadActiveSigningKey,
  type CredentialIssuerDeps,
  type IssueCredentialDeps,
  credentialValidUntilOf,
  type ActiveSigningKey,
  loadAssertionSource,
} from './credential-issuer.js'

export { makeSigningKeyProvider } from './signing-key-provider.factory.js'
export {
  type SigningKeyProvider,
  type SigningKeyRequest,
  SigningKeyProviderError,
} from './signing-key-provider.js'
