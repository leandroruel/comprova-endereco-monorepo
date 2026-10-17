import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

export const VERDICTS = [
  'CONFIRMED_COMMERCIAL',
  'SHARED_VIRTUAL',
  'OCCUPIED_BY_OTHER_ENTITY',
  'RESIDENTIAL',
  'NOT_FOUND',
  'FOREIGN',
  'INCONSISTENT',
  'INSUFFICIENT_EVIDENCE',
] as const

export type Verdict = (typeof VERDICTS)[number]

export const HardRuleSchema = z.object({
  id: z.string(),
  when_checker: z.string(),
  when_detail_equals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  verdict: z.enum(VERDICTS),
  confidence: z.number().min(0).max(1),
})

export const PolicySchema = z.object({
  version: z.string().min(1),
  weights: z.record(z.string(), z.number().positive()),
  hard_rules: z.array(HardRuleSchema),
  required_checkers: z.array(z.string()),
  decision: z.object({
    insufficient_band: z.tuple([z.number(), z.number()]),
    conflict_threshold: z.number(),
    confirmed_threshold: z.number(),
  }),
})

export type HardRule = z.infer<typeof HardRuleSchema>
export type Policy = z.infer<typeof PolicySchema>

/**
 * Digest do CONTEÚDO EFETIVO da policy (os bytes do YAML carregado), não do
 * caminho/nome do arquivo nem de um objeto JS serializado de forma não canônica.
 * `policy_version + policy_hash` identifica inequivocamente o conteúdo usado.
 */
export const policyHashOf = (yamlContent: string): string =>
  createHash('sha256').update(yamlContent, 'utf8').digest('hex')

export const loadPolicy = (yamlContent: string, expectedVersion?: string): Policy => {
  const raw: unknown = parseYaml(yamlContent)
  const policy = PolicySchema.parse(raw)
  if (expectedVersion !== undefined && policy.version !== expectedVersion) {
    throw new Error(
      `policy version mismatch: file declares '${policy.version}' but expected '${expectedVersion}'`,
    )
  }
  return policy
}
