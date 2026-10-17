import { existsSync } from 'node:fs'
import path from 'node:path'

export interface WorkerEnv {
  readonly databaseUrl: string
  readonly policyVersion: string
  readonly repoRoot: string
  readonly vlmEnabled: boolean
  readonly nominatimUrl?: string
  readonly overpassUrl?: string
  readonly googleStreetViewKey?: string
  readonly openAiKey?: string
  readonly s3Endpoint?: string
  readonly s3Region?: string
  readonly s3Bucket?: string
  readonly s3AccessKeyId?: string
  readonly s3SecretAccessKey?: string
  readonly storeStreetViewImages?: boolean
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
    googleStreetViewKey: nonEmpty(env.GOOGLE_STREET_VIEW_KEY),
    openAiKey: nonEmpty(env.OPENAI_API_KEY),
    s3Endpoint: nonEmpty(env.S3_ENDPOINT),
    s3Region: nonEmpty(env.S3_REGION),
    s3Bucket: nonEmpty(env.S3_BUCKET),
    s3AccessKeyId: nonEmpty(env.S3_ACCESS_KEY_ID),
    s3SecretAccessKey: nonEmpty(env.S3_SECRET_ACCESS_KEY),
  }

  return {
    databaseUrl,
    policyVersion: env.POLICY_VERSION ?? '2026.12.1',
    repoRoot: findRepoRoot(process.cwd()),
    vlmEnabled: env.VLM_ENABLED === 'true',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    ...(env.STORE_STREET_VIEW_IMAGES === 'true' ? { storeStreetViewImages: true } : {}),
  }
}
