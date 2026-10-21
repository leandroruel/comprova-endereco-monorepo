import { assertProductionIssuerOrigin, IssuerOriginSchema } from '@comprova/credential'
import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  API_KEY_PEPPER: z.string().min(8),
  /**
   * Origem HTTPS controlada pelo projeto: base do `issuer` e do
   * `credentialSubject.id` das credenciais emitidas (ADR-0024). Sem default —
   * a biblioteca não declara controle de domínio nenhum —, validada e
   * normalizada por `parseIssuerOrigin`.
   */
  CREDENTIAL_ISSUER_ORIGIN: IssuerOriginSchema,
  /**
   * Material de assinatura por tenant (FASE 14). JSON: lista de
   * `{ "tenant_id": <uuid>, "key_id": <fragmento>, "private_key_pem": <PKCS#8 PEM Ed25519> }`.
   *
   * A chave PRIVADA fica aqui (configuração/segredo externo) e é associada à
   * chave publicada no banco por (`tenant_id`, `key_id`) — nunca é persistida
   * (ADR-0026). É lida no boot por `makeConfiguredSigningKeyProvider` (provider
   * de assinatura local): JSON inválido, PEM inválida ou não-Ed25519 derrubam a
   * API antes de aceitar tráfego. Vazio = nenhum tenant provisionado; a emissão
   * daquele tenant falha fechado.
   */
  CREDENTIAL_SIGNING_KEYS: z.string().default('[]'),
  /**
   * Backend de assinatura (roadmap #24, etapa 24.3). `local` usa o material
   * privado de `CREDENTIAL_SIGNING_KEYS` (comportamento atual); `aws-kms` usa
   * chaves Ed25519 no AWS KMS, referenciadas por
   * `issuer_signing_key.kms_key_reference`.
   *
   * O default é `local`: KMS nunca vira default silenciosamente. Um backend
   * remoto é escolha explícita e falha fechado se a chave ativa não tiver
   * referência KMS (e vice-versa).
   */
  SIGNING_KEY_PROVIDER: z.enum(['local', 'aws-kms']).default('local'),
  /**
   * Região do AWS KMS. Opcional: ausente, o SDK usa a cadeia padrão do AWS
   * (`AWS_REGION`/config). Credenciais NÃO são configuradas aqui: o SDK usa a
   * credential provider chain (IAM role, SSO, etc.) — nenhuma access key entra
   * no `.env`.
   */
  AWS_KMS_REGION: z.string().min(1).optional(),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  POLICY_VERSION: z.string().default('2026.13.1'),
  TEMPORAL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  VLM_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE: z.string().default('comprova-deep-t1'),
  WORKER_LOOPS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`)
  }
  // Fora de desenvolvimento/teste a origem precisa ser um nome DNS público:
  // `issuer.test`, `localhost`, `.local` e IP literal passam pelo parser (são
  // HTTPS válidos) mas nunca seriam identificadores públicos de um issuer. O
  // guard é fail-safe: `NODE_ENV` ausente, `prod` ou `staging` também recusam
  // (não dá para assumir que a ausência do valor significa desenvolvimento).
  const relaxedIssuerOrigin = env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
  if (!relaxedIssuerOrigin) {
    try {
      assertProductionIssuerOrigin(parsed.data.CREDENTIAL_ISSUER_ORIGIN)
    } catch (error) {
      throw new Error(
        `invalid configuration: CREDENTIAL_ISSUER_ORIGIN: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return parsed.data
}
