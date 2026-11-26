import { EVIDENCE_ARTIFACT_MAX_BYTES } from '@comprova/db'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface WorkerEnv {
  readonly databaseUrl: string
  /** Database de referência (CNEFE/Receita). Ausente = modo single-database. */
  readonly referenceDbUrl?: string
  readonly policyVersion: string
  readonly repoRoot: string
  readonly logLevel: string
  readonly logFile?: string
  readonly nominatimUrl?: string
  readonly overpassUrl?: string
  readonly s3Endpoint?: string
  readonly s3Region?: string
  readonly s3Bucket?: string
  readonly s3AccessKeyId?: string
  readonly s3SecretAccessKey?: string
  readonly supabaseUrl?: string
  readonly supabaseServiceRoleKey?: string
  readonly supabaseStorageBucket?: string
  /** Local filesystem storage path for development/local validation. */
  readonly localStoragePath?: string
  /** Limite de bytes que o analisador F1.2 carrega em memória. */
  readonly evidenceAnalysisMaxBytes: number
  /**
   * Serviço Document Intelligence (Marker) usado como fallback/OCR quando a
   * camada textual local é insuficiente. Ausente = analyzer apenas local.
   */
  readonly documentIntelligenceUrl?: string
  readonly documentIntelligenceTimeoutMs?: number
  readonly documentIntelligenceMaxFileSizeMb?: number
  /** Origem HTTPS do issuer de credencial (`CREDENTIAL_ISSUER_ORIGIN`). */
  readonly credentialIssuerOrigin?: string
  /** Material de assinatura por tenant (JSON). */
  readonly credentialSigningKeys?: string
  /** Backend de assinatura: 'local' ou 'aws-kms'. */
  readonly signingKeyProvider?: 'local' | 'aws-kms'
  /** Região do AWS KMS. */
  readonly awsKmsRegion?: string
}

export const findRepoRoot = (startDir: string): string => {
  const root = path.parse(startDir).root
  if (startDir === root) throw new Error('repo root (pnpm-workspace.yaml) not found')
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value !== '' ? value : undefined

export const workerEnvFromProcess = (env: NodeJS.ProcessEnv = process.env): WorkerEnv => {
  const databaseUrl = env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')

  const optional = {
    nominatimUrl: nonEmpty(env.NOMINATIM_URL),
    overpassUrl: nonEmpty(env.OVERPASS_URL),
    s3Endpoint: nonEmpty(env.S3_ENDPOINT),
    s3Region: nonEmpty(env.S3_REGION),
    s3Bucket: nonEmpty(env.S3_BUCKET),
    s3AccessKeyId: nonEmpty(env.S3_ACCESS_KEY_ID),
    s3SecretAccessKey: nonEmpty(env.S3_SECRET_ACCESS_KEY),
    supabaseUrl: nonEmpty(env.SUPABASE_URL),
    supabaseServiceRoleKey: nonEmpty(env.SUPABASE_SERVICE_ROLE_KEY),
    supabaseStorageBucket: nonEmpty(env.SUPABASE_STORAGE_BUCKET),
    localStoragePath: nonEmpty(env.LOCAL_STORAGE_PATH),
    documentIntelligenceUrl: nonEmpty(env.DOCUMENT_INTELLIGENCE_URL),
    credentialIssuerOrigin: nonEmpty(env.CREDENTIAL_ISSUER_ORIGIN),
    credentialSigningKeys: nonEmpty(env.CREDENTIAL_SIGNING_KEYS),
    signingKeyProvider: nonEmpty(env.SIGNING_KEY_PROVIDER),
    awsKmsRegion: nonEmpty(env.AWS_KMS_REGION),
  }

  const parsedAnalysisMaxBytes = Number(
    nonEmpty(env.EVIDENCE_ANALYSIS_MAX_BYTES) ?? EVIDENCE_ARTIFACT_MAX_BYTES,
  )
  if (
    !Number.isInteger(parsedAnalysisMaxBytes) ||
    parsedAnalysisMaxBytes <= 0 ||
    parsedAnalysisMaxBytes > EVIDENCE_ARTIFACT_MAX_BYTES
  ) {
    throw new Error(
      `EVIDENCE_ANALYSIS_MAX_BYTES must be an integer between 1 and ${EVIDENCE_ARTIFACT_MAX_BYTES}`,
    )
  }

  // Timeout do cliente HTTP do Document Intelligence. Deve ficar ACIMA do
  // `DI_TIMEOUT_S` do serviço (300 s por padrão) para que o 504 estruturado
  // chegue antes do abort. Mesmo limite máximo da API.
  const parsedDiTimeoutMs = Number(nonEmpty(env.DOCUMENT_INTELLIGENCE_TIMEOUT_MS) ?? 360_000)
  if (!Number.isInteger(parsedDiTimeoutMs) || parsedDiTimeoutMs <= 0 || parsedDiTimeoutMs > 3_600_000) {
    throw new Error('DOCUMENT_INTELLIGENCE_TIMEOUT_MS must be an integer between 1 and 3600000')
  }

  const parsedDiMaxFileSizeMb = Number(nonEmpty(env.DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB) ?? 30)
  if (
    !Number.isInteger(parsedDiMaxFileSizeMb) ||
    parsedDiMaxFileSizeMb <= 0 ||
    parsedDiMaxFileSizeMb > 1024
  ) {
    throw new Error('DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB must be an integer between 1 and 1024')
  }

  return {
    databaseUrl,
    referenceDbUrl: nonEmpty(env.REFERENCE_DATABASE_URL),
    policyVersion: env.POLICY_VERSION ?? '2026.14.1',
    repoRoot: findRepoRoot(process.cwd()),
    evidenceAnalysisMaxBytes: parsedAnalysisMaxBytes,
    documentIntelligenceTimeoutMs: parsedDiTimeoutMs,
    documentIntelligenceMaxFileSizeMb: parsedDiMaxFileSizeMb,
    logLevel: env.LOG_LEVEL ?? 'info',
    logFile: nonEmpty(env.LOG_FILE),
    credentialIssuerOrigin: optional.credentialIssuerOrigin,
    credentialSigningKeys: optional.credentialSigningKeys,
    signingKeyProvider: (optional.signingKeyProvider as 'local' | 'aws-kms') ?? 'local',
    awsKmsRegion: optional.awsKmsRegion,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  }
}
