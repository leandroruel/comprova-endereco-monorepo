import type { DeepEnrichInput, DeepEnrichResult } from './deep-enrich.js'
import { loadPolicy, systemClock, type Checker, type Policy } from '@comprova/core'
import { makeT1Checkers } from '@comprova/checkers'
import { createDbPool, makeCnefeCoordReader, type DbPool } from '@comprova/db'
import { makeNominatimGeocoder, makeOverpassPlaces } from '@comprova/providers'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { deepEnrich } from './deep-enrich.js'

export interface DeepWorkerEnv {
  readonly databaseUrl: string
  readonly policyVersion: string
  readonly repoRoot: string
  readonly nominatimUrl?: string
  readonly overpassUrl?: string
}

export interface DeepWorkerContext {
  readonly pool: DbPool
  readonly policy: Policy
  readonly t1Checkers: readonly Checker[]
}

const findRepoRoot = (startDir: string): string => {
  const root = path.parse(startDir).root
  if (startDir === root) throw new Error('repo root (pnpm-workspace.yaml) not found')
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
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
    places: makeOverpassPlaces(env.overpassUrl !== undefined ? { baseUrl: env.overpassUrl } : {}),
  })
  return { pool, policy, t1Checkers }
}

export const makeDeepEnrichActivity =
  (ctx: DeepWorkerContext) =>
  async (input: DeepEnrichInput): Promise<DeepEnrichResult> =>
    deepEnrich(
      {
        db: ctx.pool.db,
        t1Checkers: ctx.t1Checkers,
        policy: ctx.policy,
        clock: systemClock,
      },
      input,
    )

export type DeepActivities = {
  deepEnrichActivity: (input: DeepEnrichInput) => Promise<DeepEnrichResult>
}

export const workerEnvFromProcess = (env: NodeJS.ProcessEnv = process.env): DeepWorkerEnv => {
  const databaseUrl = env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
  const policyVersion = env.POLICY_VERSION ?? '2026.11.1'
  const repoRoot = findRepoRoot(process.cwd())
  return {
    databaseUrl,
    policyVersion,
    repoRoot,
    ...(env.NOMINATIM_URL !== undefined ? { nominatimUrl: env.NOMINATIM_URL } : {}),
    ...(env.OVERPASS_URL !== undefined ? { overpassUrl: env.OVERPASS_URL } : {}),
  }
}
