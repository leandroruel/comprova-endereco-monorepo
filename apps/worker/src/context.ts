import { FACADE_PROMPT, makeStreetViewVlm, makeT1Checkers, type EvidenceWriter } from '@comprova/checkers'
import { loadPolicy, policyHashOf, type Checker, type Policy, type SignalCacheReader } from '@comprova/core'
import {
  createDbPool,
  makeCnefeCoordReader,
  makePartnerGraphReader,
  makeSignalCacheReader,
  type DbPool,
} from '@comprova/db'
import {
  makeFakeObjectStore,
  makeGoogleStreetView,
  makeNominatimGeocoder,
  makeOpenAIVisionModel,
  makeOverpassPlaces,
  makeS3ObjectStore,
  makeStubVisionModel,
  type EvidenceObjectStore,
} from '@comprova/providers'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkerEnv } from './config.js'
import { makeEvidenceWriter } from './modules/evidence/evidence.service.js'

export interface WorkerContext {
  readonly pool: DbPool
  readonly policy: Policy
  readonly policyHash: string
  readonly t1Checkers: readonly Checker[]
  readonly t2Checkers: readonly Checker[]
  readonly evidenceWriter: EvidenceWriter
  readonly signalCache: SignalCacheReader
}

export const makeObjectStore = (env: WorkerEnv): EvidenceObjectStore =>
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

export const buildT2Checkers = (env: WorkerEnv, evidenceWriter: EvidenceWriter): readonly Checker[] => {
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

export const buildWorkerContext = (env: WorkerEnv): WorkerContext => {
  const policyYaml = readFileSync(path.join(env.repoRoot, 'policies', `${env.policyVersion}.yaml`), 'utf8')
  const policy = loadPolicy(policyYaml)
  const pool = createDbPool(env.databaseUrl)
  const t1Checkers = makeT1Checkers({
    geocoder: makeNominatimGeocoder(env.nominatimUrl !== undefined ? { baseUrl: env.nominatimUrl } : {}),
    cnefeCoords: makeCnefeCoordReader(pool.db),
    partnerGraph: makePartnerGraphReader(pool.db),
    places: makeOverpassPlaces(env.overpassUrl !== undefined ? { baseUrl: env.overpassUrl } : {}),
  })

  const evidenceWriter = makeEvidenceWriter(pool.db, makeObjectStore(env))

  return {
    pool,
    policy,
    policyHash: policyHashOf(policyYaml),
    t1Checkers,
    t2Checkers: buildT2Checkers(env, evidenceWriter),
    evidenceWriter,
    signalCache: makeSignalCacheReader(pool.db),
  }
}
