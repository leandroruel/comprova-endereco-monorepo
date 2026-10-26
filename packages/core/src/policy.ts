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

/** 30 dias: mesmo horizonte histórico de retenção/validade, agora explícito. */
export const DEFAULT_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Força que a policy atribui a uma observação de um checker de fonte externa
 * (ex.: `nf3e_verification`). Substitui o `strength`/`confidence` gravados na
 * observação — as fontes materializadas sem `signal` (upload/F1.3, fiscal/F2)
 * gravam `0` e a decisão de força pertence à policy (F3), não ao adapter.
 *
 * O slice atual aplica esta força **somente a `stance = supports`**: `differs`
 * (contradicts), `not_extracted` e estados neutros/indisponíveis permanecem sem
 * força e nunca viram hard rule por aqui.
 */
export const EvidenceCheckerPolicySchema = z.object({
  strength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
})

export const PolicySchema = z.object({
  version: z.string().min(1),
  weights: z.record(z.string(), z.number().positive()),
  hard_rules: z.array(HardRuleSchema),
  required_checkers: z.array(z.string()),
  /**
   * Força de evidência por checker de fonte externa. Campo opcional: policies
   * já publicadas (sem o campo) continuam parseando e mantendo o hash do YAML.
   */
  evidence_checkers: z.record(z.string(), EvidenceCheckerPolicySchema).default(() => ({})),
  /**
   * Horizonte da CREDENCIAL (não da retenção): `validUntil` é
   * `completed_at + credential_ttl_seconds`, limitado pelo TTL de cada
   * evidência. O default preserva as policies já publicadas, cujo YAML não
   * contém o campo (e cujo hash não pode mudar).
   */
  credential_ttl_seconds: z.number().int().positive().default(DEFAULT_CREDENTIAL_TTL_SECONDS),
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
