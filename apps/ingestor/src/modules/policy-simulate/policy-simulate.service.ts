import {
  decide,
  loadPolicy,
  mapSequential,
  weightedScore,
  type Policy,
  type Signal,
  type Verdict,
} from '@comprova/core'
import { eq } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { findRepoRoot } from '../../lib/repo-root.js'

export interface SimulationDiff {
  readonly validationId: string
  readonly storedVerdict: Verdict
  readonly simulatedVerdict: Verdict
  readonly storedPolicyVersion: string
}

export interface SimulationTransition {
  readonly from: Verdict
  readonly to: Verdict
  readonly count: number
}

export interface SimulationReport {
  readonly targetPolicyVersion: string
  readonly total: number
  readonly divergent: number
  readonly transitions: readonly SimulationTransition[]
  readonly samples: readonly SimulationDiff[]
}

export const loadPolicyVersion = (version: string, startDir = process.cwd()): Policy =>
  loadPolicy(readFileSync(path.join(findRepoRoot(startDir), 'policies', `${version}.yaml`), 'utf8'))

const toDomainSignal = (row: t.Signal): Signal => ({
  checkerId: row.checkerId,
  checkerVersion: row.checkerVersion,
  stance: row.stance,
  strength: row.strength,
  confidence: row.confidence,
  source: row.source,
  observedAt: row.observedAt.toISOString(),
  ttlSeconds: row.ttlSeconds,
  detail: row.detail,
})

/** Replay de uma validação com a política-alvo; `null` quando o veredito não muda. */
const diffFor = async (
  db: Db,
  validation: {
    readonly validationId: string
    readonly verdict: Verdict | null
    readonly policyVersion: string
    readonly createdAt: Date
  },
  targetPolicy: Policy,
): Promise<SimulationDiff | null> => {
  if (validation.verdict === null) return null

  const signals = await db.select().from(t.signal).where(eq(t.signal.validationId, validation.validationId))
  const domainSignals = signals.map(toDomainSignal)
  const score = weightedScore(domainSignals, targetPolicy, validation.createdAt)
  const decision = decide({ signals: domainSignals, score, policy: targetPolicy, now: validation.createdAt })

  return decision.verdict === validation.verdict
    ? null
    : {
        validationId: validation.validationId,
        storedVerdict: validation.verdict,
        simulatedVerdict: decision.verdict,
        storedPolicyVersion: validation.policyVersion,
      }
}

/** Soma imutavelmente uma transição de veredito à lista de transições. */
const mergeTransition = (
  transitions: readonly SimulationTransition[],
  diff: SimulationDiff,
): readonly SimulationTransition[] => {
  const index = transitions.findIndex(
    (tr) => tr.from === diff.storedVerdict && tr.to === diff.simulatedVerdict,
  )
  const existing = transitions[index]
  return existing === undefined
    ? [...transitions, { from: diff.storedVerdict, to: diff.simulatedVerdict, count: 1 }]
    : transitions.map((tr, i) => (i === index ? { ...tr, count: tr.count + 1 } : tr))
}

export const simulatePolicy = async (
  db: Db,
  targetVersion: string,
  startDir = process.cwd(),
  limit = 500,
): Promise<SimulationReport> => {
  const targetPolicy = loadPolicyVersion(targetVersion, startDir)

  const validations = await db
    .select({
      validationId: t.validation.validationId,
      verdict: t.validation.verdict,
      policyVersion: t.validation.policyVersion,
      createdAt: t.validation.createdAt,
    })
    .from(t.validation)
    .limit(limit)

  const diffs = (
    await mapSequential(validations, (validation) => diffFor(db, validation, targetPolicy))
  ).filter((diff): diff is SimulationDiff => diff !== null)

  return {
    targetPolicyVersion: targetPolicy.version,
    total: validations.length,
    divergent: diffs.length,
    transitions: diffs.reduce(mergeTransition, []),
    samples: diffs.slice(0, 10),
  }
}
