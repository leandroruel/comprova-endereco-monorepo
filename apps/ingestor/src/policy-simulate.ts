import { decide, loadPolicy, weightedScore, type Policy, type Signal, type Verdict } from '@comprova/core'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface SimulationDiff {
  readonly validationId: string
  readonly storedVerdict: Verdict
  readonly simulatedVerdict: Verdict
  readonly storedPolicyVersion: string
}

export interface SimulationReport {
  readonly targetPolicyVersion: string
  readonly total: number
  readonly divergent: number
  readonly transitions: ReadonlyArray<{
    readonly from: Verdict
    readonly to: Verdict
    readonly count: number
  }>
  readonly samples: readonly SimulationDiff[]
}

const findRepoRoot = (startDir: string): string => {
  const root = path.parse(startDir).root
  if (startDir === root) throw new Error('repo root (pnpm-workspace.yaml) not found')
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
}

export const loadPolicyVersion = (version: string, startDir = process.cwd()): Policy =>
  loadPolicy(readFileSync(path.join(findRepoRoot(startDir), 'policies', `${version}.yaml`), 'utf8'))

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

  const diffs = await validations.reduce<Promise<readonly SimulationDiff[]>>(async (acc, validation) => {
    const prior = await acc
    if (validation.verdict === null) return prior
    const signals = await db
      .select()
      .from(t.signal)
      .where((await import('@comprova/db')).eq(t.signal.validationId, validation.validationId))
    const domainSignals: readonly Signal[] = signals.map((s) => ({
      checkerId: s.checkerId,
      checkerVersion: s.checkerVersion,
      stance: s.stance,
      strength: s.strength,
      confidence: s.confidence,
      source: s.source,
      observedAt: s.observedAt.toISOString(),
      ttlSeconds: s.ttlSeconds,
      detail: s.detail,
    }))
    const score = weightedScore(domainSignals, targetPolicy, validation.createdAt)
    const decision = decide({
      signals: domainSignals,
      score,
      policy: targetPolicy,
      now: validation.createdAt,
    })
    if (decision.verdict === validation.verdict) return prior
    return [
      ...prior,
      {
        validationId: validation.validationId,
        storedVerdict: validation.verdict,
        simulatedVerdict: decision.verdict,
        storedPolicyVersion: validation.policyVersion,
      },
    ]
  }, Promise.resolve([]))

  const transitionMap = new Map<string, { from: Verdict; to: Verdict; count: number }>()
  for (const diff of diffs) {
    const key = `${diff.storedVerdict}->${diff.simulatedVerdict}`
    const entry = transitionMap.get(key)
    transitionMap.set(key, {
      from: diff.storedVerdict,
      to: diff.simulatedVerdict,
      count: (entry?.count ?? 0) + 1,
    })
  }

  return {
    targetPolicyVersion: targetPolicy.version,
    total: validations.length,
    divergent: diffs.length,
    transitions: [...transitionMap.values()],
    samples: diffs.slice(0, 10),
  }
}
