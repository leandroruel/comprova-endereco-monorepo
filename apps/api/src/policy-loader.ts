import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadPolicy, type Policy } from '@comprova/core'
import { readFileSync } from 'node:fs'

export const findRepoRoot = (startDir: string): string => {
  if (startDir === path.parse(startDir).root) {
    throw new Error('repo root (pnpm-workspace.yaml) not found')
  }
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
}

export const loadPolicyFile = (policyVersion: string, startDir = process.cwd()): Policy => {
  const policyPath = path.join(findRepoRoot(startDir), 'policies', `${policyVersion}.yaml`)
  return loadPolicy(readFileSync(policyPath, 'utf8'))
}
