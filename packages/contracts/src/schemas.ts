import { z } from 'zod'

export const DocTypeSchema = z.enum(['CPF', 'CNPJ'])
export const ValModeSchema = z.enum(['fast', 'deep', 'auto'])
export const ValStatusSchema = z.enum(['queued', 'running', 'partial', 'completed', 'failed', 'expired'])
export const VerdictSchema = z.enum([
  'CONFIRMED_COMMERCIAL',
  'SHARED_VIRTUAL',
  'OCCUPIED_BY_OTHER_ENTITY',
  'RESIDENTIAL',
  'NOT_FOUND',
  'FOREIGN',
  'INCONSISTENT',
  'INSUFFICIENT_EVIDENCE',
])
export const StanceSchema = z.enum(['supports', 'contradicts', 'neutral', 'unknown'])
export const GeoPrecisionSchema = z.enum([
  'ROOFTOP',
  'RANGE_INTERPOLATED',
  'GEOMETRIC_CENTER',
  'APPROXIMATE',
  'NONE',
])
export const LegalBasisSchema = z.enum(['FRAUD_PREVENTION', 'CONTRACT_EXECUTION', 'CONSENT'])

export const DocumentSchema = z.object({
  type: DocTypeSchema,
  value: z.string().min(11).max(20),
})

export const ValidationOptionsSchema = z.object({
  include_evidence: z.boolean().default(false),
  max_tier: z.number().int().min(0).max(2).default(2),
})

export const AddressInputSchema = z.object({
  tipo_logradouro: z.string().optional(),
  logradouro: z.string().min(1),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cep: z.string().optional(),
  uf: z.string().length(2).optional(),
  municipio: z.string().optional(),
  municipio_ibge: z.number().int().optional(),
  country_code: z.string().length(2).default('BR'),
})

export const CreateValidationRequestSchema = z.object({
  document: DocumentSchema,
  address: AddressInputSchema.nullable().default(null),
  mode: ValModeSchema.default('auto'),
  legal_basis: LegalBasisSchema,
  consent_ref: z.string().min(1).nullable().default(null),
  callback_url: z.url().nullable().default(null),
  options: ValidationOptionsSchema.default({ include_evidence: false, max_tier: 2 }),
})

export const SignalDtoSchema = z.object({
  checker: z.string(),
  checker_version: z.string(),
  stance: StanceSchema,
  strength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  source: z.string(),
  observed_at: z.iso.datetime(),
  ttl_seconds: z.number().int().nonnegative(),
  detail: z.record(z.string(), z.unknown()),
  evidence_id: z.uuid().nullable().optional(),
})

export const AddressSummaryDtoSchema = z.object({
  building_key: z.string(),
  country: z.string().length(2),
  uf: z.string().length(2).nullable(),
  geo_precision: GeoPrecisionSchema,
})

export const ValidationDtoSchema = z.object({
  validation_id: z.uuid(),
  status: ValStatusSchema,
  verdict: VerdictSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  score: z.number().min(-1).max(1).nullable(),
  policy_version: z.string().nullable(),
  address: AddressSummaryDtoSchema.nullable(),
  signals: z.array(SignalDtoSchema),
  explanation: z.string().nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
})

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  request_id: z.string().optional(),
})

export type DocType = z.infer<typeof DocTypeSchema>
export type ValMode = z.infer<typeof ValModeSchema>
export type ValStatus = z.infer<typeof ValStatusSchema>
export type Verdict = z.infer<typeof VerdictSchema>
export type Stance = z.infer<typeof StanceSchema>
export type CreateValidationRequest = z.infer<typeof CreateValidationRequestSchema>
export type ValidationDto = z.infer<typeof ValidationDtoSchema>
export type SignalDto = z.infer<typeof SignalDtoSchema>
