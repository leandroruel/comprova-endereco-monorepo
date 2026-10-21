import type { AppConfig } from '../config.js'
import { makeConfiguredSigningKeyProvider, type SigningKeyProvider } from './signing-key-provider.js'

export type SigningKeyProviderConfig = Pick<
  AppConfig,
  'SIGNING_KEY_PROVIDER' | 'CREDENTIAL_SIGNING_KEYS' | 'AWS_KMS_REGION'
>

/**
 * Seleção explícita do backend de assinatura (roadmap #24, etapa 24.3).
 *
 * `local` (default) é o comportamento atual: material em
 * `CREDENTIAL_SIGNING_KEYS`. `aws-kms` é opt-in e importa o SDK do KMS só nesse
 * caminho — um boot local não instancia cliente AWS nem exige credenciais.
 *
 * O backend é GLOBAL nesta etapa (não por chave): um tenant cuja chave ativa não
 * pertence ao backend selecionado falha fechado. Misturar backends no mesmo
 * processo exigiria um provider por chave, deliberadamente fora do escopo.
 */
export const makeSigningKeyProvider = async (
  config: SigningKeyProviderConfig,
): Promise<SigningKeyProvider> => {
  if (config.SIGNING_KEY_PROVIDER === 'local') {
    return makeConfiguredSigningKeyProvider(config.CREDENTIAL_SIGNING_KEYS)
  }
  const { makeAwsKmsSigningKeyProviderFromConfig } = await import('./aws-kms-signing-key-provider.js')
  return makeAwsKmsSigningKeyProviderFromConfig(config.AWS_KMS_REGION)
}
