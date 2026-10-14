import type { DeepEnrichInput, DeepEnrichResult } from './deep-enrich.js'
import { loadPolicy, systemClock, type Checker, type Policy, type SignalCacheReader } from '@comprova/core'
import { FACADE_PROMPT, makeStreetViewVlm, makeT1Checkers, type EvidenceWriter } from '@comprova/checkers'
import { createDbPool, makeCnefeCoordReader, makePartnerGraphReader, type DbPool } from '@comprova/db'
import {
  makeFakeObjectStore,
  makeGoogleStreetView,
  makeNominatimGeocoder,
  makeOpenAIVisionModel,
  makeOverpassPlaces,
  makeS3ObjectStore,
  makeStubVisionModel,
} from '@comprova/providers'
import { makeEvidenceWriter } from './evidence.js'
import { makeSignalCacheReader } from '@comprova/db'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { deepEnrich } from './deep-enrich.js'

export interface DeepWorkerEnv {
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

export interface DeepWorkerContext {
  readonly pool: DbPool
  readonly policy: Policy
  readonly t1Checkers: readonly Checker[]
  readonly t2Checkers: readonly Checker[]
  readonly evidenceWriter: EvidenceWriter
  readonly signalCache: SignalCacheReader
}

const findRepoRoot = (startDir: string): string => {
  const root = path.parse(startDir).root
  if (startDir === root) throw new Error('repo root (pnpm-workspace.yaml) not found')
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
}

export const buildT2Checkers = (env: DeepWorkerEnv, evidenceWriter: EvidenceWriter): readonly Checker[] => {
  if (!env.vlmEnabled) return []
  const streetView = makeGoogleStreetView({ apiKey: env.googleStreetViewKey })
  const vision =
    env.openAiKey !== undefined && env.openAiKey !== ''
      ? makeOpenAIVisionModel({ apiKey: env.openAiKey, prompt: FACADE_PROMPT })
      : makeStubVisionModel()
  return [
    makeStreetViewVlm({
      streetView,
      vision,
      evidenceWriter,
      ...(env.storeStreetViewImages === true ? { storeImages: true } : {}),
    }),
  ]
}

export const buildDeepWorkerContext = (env: DeepWorkerEnv): DeepWorkerContext => {
  const policy = loadPolicy(
    readFileSync(path.join(env.repoRoot, 'policies', `${env.policyVersion}.yaml`), 'utf8'),
  )
  const pool = createDbPool(env.databaseUrl)
  const cnefeCoords = makeCnefeCoordReader(pool.db)
  const t1Checkers = makeT1Checkers({
    geocoder: makeNominatimGeocoder(env.nominatimUrl !== undefined ? { baseUrl: env.nominatimUrl } : {}),
    cnefeCoords,
    partnerGraph: makePartnerGraphReader(pool.db),
    places: makeOverpassPlaces(env.overpassUrl !== undefined ? { baseUrl: env.overpassUrl } : {}),
  })

  const objectStore =
    env.s3Endpoint !== undefined &&
    env.s3AccessKeyId !== undefined &&
    env.s3SecretAccessKey !== undefined &&
    env.s3Bucket !== undefined
      ? makeS3ObjectStore({
          endpoint: env.s3Endpoint,
          region: env.s3Region ?? 'us-east-1',
          bucket: env.s3Bucket,
          accessKeyId: env.s3AccessKeyId,
          secretAccessKey: env.s3SecretAccessKey,
        })
      : makeFakeObjectStore()
  const evidenceWriter = makeEvidenceWriter(pool.db, objectStore)

  const t2Checkers = buildT2Checkers(env, evidenceWriter)

  const signalCache = makeSignalCacheReader(pool.db)
  return { pool, policy, t1Checkers, t2Checkers, evidenceWriter, signalCache }
}

export const makeDeepEnrichActivity =
  (ctx: DeepWorkerContext) =>
  async (input: DeepEnrichInput): Promise<DeepEnrichResult> =>
    deepEnrich(
      {
        db: ctx.pool.db,
        t1Checkers: ctx.t1Checkers,
        t2Checkers: ctx.t2Checkers,
        policy: ctx.policy,
        clock: systemClock,
        ...(ctx.signalCache !== undefined ? { signalCache: ctx.signalCache } : {}),
      },
      input,
    )

export type DeepActivities = {
  deepEnrichActivity: (input: DeepEnrichInput) => Promise<DeepEnrichResult>
}

export const workerEnvFromProcess = (env: NodeJS.ProcessEnv = process.env): DeepWorkerEnv => {
  const databaseUrl = env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
  const nonEmpty = (v: string | undefined): string | undefined =>
    v !== undefined && v !== '' ? v : undefined
  const nominatimUrl = nonEmpty(env.NOMINATIM_URL)
  const overpassUrl = nonEmpty(env.OVERPASS_URL)
  const googleStreetViewKey = nonEmpty(env.GOOGLE_STREET_VIEW_KEY)
  const openAiKey = nonEmpty(env.OPENAI_API_KEY)
  const s3Endpoint = nonEmpty(env.S3_ENDPOINT)
  const s3Region = nonEmpty(env.S3_REGION)
  const s3Bucket = nonEmpty(env.S3_BUCKET)
  const s3AccessKeyId = nonEmpty(env.S3_ACCESS_KEY_ID)
  const s3SecretAccessKey = nonEmpty(env.S3_SECRET_ACCESS_KEY)
  return {
    databaseUrl,
    policyVersion: env.POLICY_VERSION ?? '2026.12.1',
    repoRoot: findRepoRoot(process.cwd()),
    vlmEnabled: env.VLM_ENABLED === 'true',
    ...(nominatimUrl !== undefined ? { nominatimUrl } : {}),
    ...(overpassUrl !== undefined ? { overpassUrl } : {}),
    ...(googleStreetViewKey !== undefined ? { googleStreetViewKey } : {}),
    ...(openAiKey !== undefined ? { openAiKey } : {}),
    ...(s3Endpoint !== undefined ? { s3Endpoint } : {}),
    ...(s3Region !== undefined ? { s3Region } : {}),
    ...(s3Bucket !== undefined ? { s3Bucket } : {}),
    ...(s3AccessKeyId !== undefined ? { s3AccessKeyId } : {}),
    ...(s3SecretAccessKey !== undefined ? { s3SecretAccessKey } : {}),
    ...(env.STORE_STREET_VIEW_IMAGES === 'true' ? { storeStreetViewImages: true } : {}),
  }
}
