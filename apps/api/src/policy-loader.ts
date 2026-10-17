import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadPolicy, policyHashOf, type Policy } from '@comprova/core'

export const findRepoRoot = (startDir: string): string => {
  if (startDir === path.parse(startDir).root) {
    throw new Error('repo root (pnpm-workspace.yaml) not found')
  }
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
}

export interface LoadedPolicy {
  readonly policy: Policy
  /** Digest do conteúdo efetivo do YAML (V-5). */
  readonly policyHash: string
}

/**
 * Lê a policy uma única vez e devolve tanto o objeto parseado quanto o digest
 * do conteúdo efetivo, para que `validation.policy_hash` seja gravado sem
 * reler o arquivo e sem re-serializar o objeto (que não seria canônico).
 */
export const readPolicyFile = (policyVersion: string, startDir = process.cwd()): LoadedPolicy => {
  const policyPath = path.join(findRepoRoot(startDir), 'policies', `${policyVersion}.yaml`)
  const content = readFileSync(policyPath, 'utf8')
  return { policy: loadPolicy(content, policyVersion), policyHash: policyHashOf(content) }
}

export const loadPolicyFile = (policyVersion: string, startDir = process.cwd()): Policy =>
  readPolicyFile(policyVersion, startDir).policy
