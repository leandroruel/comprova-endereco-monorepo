import { assertProductionIssuerOrigin, IssuerOriginSchema } from '@comprova/credential'
import { EVIDENCE_ARTIFACT_MAX_BYTES } from '@comprova/db'
import { z } from 'zod'

/**
 * Quantos uploads de comprovante podem estar em voo por processo. Cada slot
 * pode bufferizar até `EVIDENCE_MAX_BYTES`; 4 mantém o pior caso em ~200 MiB
 * com o default de 50 MiB.
 */
export const DEFAULT_EVIDENCE_MAX_CONCURRENCY = 4

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
  LOG_FILE: z.string().min(1).optional(),
  POLICY_VERSION: z.string().default('2026.14.1'),
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
  /**
   * Object storage privado usado pelo intake de comprovantes. As quatro
   * variáveis são opcionais no boot: sem elas a rota de upload falha fechado
   * com 503 e nenhum objeto é aceito. O worker já usa as mesmas credenciais.
   */
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /**
   * Limite de upload do comprovante em bytes. O default é o limite que o
   * banco já impõe em `evidence_artifact` (50 MiB). É configurável apenas
   * para baixo, para testes e para políticas operacionais mais restritas.
   */
  EVIDENCE_MAX_BYTES: z.coerce.number().int().positive().max(EVIDENCE_ARTIFACT_MAX_BYTES).optional(),
  /**
   * Limite de uploads de comprovante simultâneos por processo. O multipart
   * bufferiza o arquivo inteiro antes de ir para o storage; sem esse limite o
   * burst do rate limit poderia reter vários arquivos de até 50 MiB. Default
   * 4, teto 16 (800 MiB no pior caso com o tamanho default). É por processo:
   * réplicas multiplicam o total.
   */
  EVIDENCE_MAX_CONCURRENCY: z.coerce.number().int().positive().max(16).optional(),
  /**
   * Serviço independente de OCR/layout (apps/document-intelligence). As três
   * variáveis são opcionais: sem `DOCUMENT_INTELLIGENCE_URL` a rota
   * `/v1/documents/parse` falha fechado com 503 e nada é enviado. Timeout e
   * tamanho usam fallbacks em `app.ts` quando ausentes.
   */
  DOCUMENT_INTELLIGENCE_URL: z.url().optional(),
  DOCUMENT_INTELLIGENCE_TIMEOUT_MS: z.coerce.number().int().positive().max(3_600_000).optional(),
  DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().max(1024).optional(),
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
