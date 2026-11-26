import { makeT1Checkers, type EvidenceWriter } from '@comprova/checkers'
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
  makeLocalFSObjectStore,
  makeNominatimGeocoder,
  makeOverpassPlaces,
  makeS3ObjectStore,
  makeSupabaseObjectStore,
  type EvidenceObjectStore,
  type LocalFSObjectStoreOptions,
} from '@comprova/providers'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkerEnv } from './config.js'
import { makeEvidenceWriter } from './modules/evidence/evidence.service.js'

export interface WorkerContext {
  readonly pool: DbPool
  /** Conexão do database de referência; null = modo single-database (transição). */
  readonly referencePool: DbPool | null
  readonly policy: Policy
  readonly policyHash: string
  readonly t1Checkers: readonly Checker[]
  readonly t2Checkers: readonly Checker[]
  readonly evidenceWriter: EvidenceWriter
  readonly signalCache: SignalCacheReader
}

type StorageConfiguredEnv = WorkerEnv & {
  readonly s3Endpoint: string
  readonly s3Bucket: string
  readonly s3AccessKeyId: string
  readonly s3SecretAccessKey: string
  readonly supabaseUrl: string
  readonly supabaseServiceRoleKey: string
  readonly supabaseStorageBucket: string
  readonly localStoragePath: string
}

export const hasStorageConfig = (env: WorkerEnv): env is StorageConfiguredEnv =>
  (env.s3Endpoint !== undefined &&
    env.s3AccessKeyId !== undefined &&
    env.s3SecretAccessKey !== undefined &&
    env.s3Bucket !== undefined) ||
  (env.supabaseUrl !== undefined &&
    env.supabaseServiceRoleKey !== undefined &&
    env.supabaseStorageBucket !== undefined) ||
  (env.localStoragePath !== undefined)

export const makeObjectStore = (env: WorkerEnv): EvidenceObjectStore => {
  if (
    env.s3Endpoint !== undefined &&
    env.s3AccessKeyId !== undefined &&
    env.s3SecretAccessKey !== undefined &&
    env.s3Bucket !== undefined
  ) {
    return makeS3ObjectStore({
      endpoint: env.s3Endpoint,
      region: env.s3Region ?? 'us-east-1',
      bucket: env.s3Bucket,
      accessKeyId: env.s3AccessKeyId,
      secretAccessKey: env.s3SecretAccessKey,
    })
  }
  if (
    env.supabaseUrl !== undefined &&
    env.supabaseServiceRoleKey !== undefined &&
    env.supabaseStorageBucket !== undefined
  ) {
    return makeSupabaseObjectStore({
      supabaseUrl: env.supabaseUrl,
      supabaseServiceRoleKey: env.supabaseServiceRoleKey,
      bucket: env.supabaseStorageBucket,
    })
  }
  if (env.localStoragePath !== undefined) {
    const localOptions: LocalFSObjectStoreOptions = { rootPath: env.localStoragePath }
    return makeLocalFSObjectStore(localOptions)
  }
  return makeFakeObjectStore()
}

export const buildT2Checkers = (_env: WorkerEnv, _evidenceWriter: EvidenceWriter): readonly Checker[] => {
  // T2/VLM checkers (Street View, OpenAI Vision) estão fora do escopo do MVP.
  return []
}

export const buildWorkerContext = (env: WorkerEnv): WorkerContext => {
  const policyYaml = readFileSync(path.join(env.repoRoot, 'policies', `${env.policyVersion}.yaml`), 'utf8')
  const policy = loadPolicy(policyYaml)
  const pool = createDbPool(env.databaseUrl)
  // Leituras de referência (CNEFE coords, partner graph) vão para o database
  // de referência quando configurado; sem EB, leem do pool operacional
  // (modo single-database preservado durante a transição).
  const referencePool = env.referenceDbUrl !== undefined ? createDbPool(env.referenceDbUrl) : null
  const refDb = referencePool?.db ?? pool.db
  const t1Checkers = makeT1Checkers({
    geocoder: makeNominatimGeocoder(env.nominatimUrl !== undefined ? { baseUrl: env.nominatimUrl } : {}),
    cnefeCoords: makeCnefeCoordReader(refDb),
    partnerGraph: makePartnerGraphReader(refDb),
    places: makeOverpassPlaces(env.overpassUrl !== undefined ? { baseUrl: env.overpassUrl } : {}),
  })

  const evidenceWriter = makeEvidenceWriter(pool.db, makeObjectStore(env))

  return {
    pool,
    referencePool,
    policy,
    policyHash: policyHashOf(policyYaml),
    t1Checkers,
    t2Checkers: buildT2Checkers(env, evidenceWriter),
    evidenceWriter,
    signalCache: makeSignalCacheReader(pool.db),
  }
}
