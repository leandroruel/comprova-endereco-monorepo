import { existsSync } from 'node:fs'
import path from 'node:path'

/** Sobe a árvore de diretórios até achar a raiz do monorepo (pnpm-workspace.yaml). */
export const findRepoRoot = (startDir: string): string => {
  const root = path.parse(startDir).root
  if (startDir === root) throw new Error('repo root (pnpm-workspace.yaml) not found')
  return existsSync(path.join(startDir, 'pnpm-workspace.yaml'))
    ? startDir
    : findRepoRoot(path.dirname(startDir))
}
