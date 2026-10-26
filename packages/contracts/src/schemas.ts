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

export const ClaimDtoSchema = z.object({
  id: z.uuid(),
  type: z.enum(['business_registered_address', 'address_exists']),
  subject: z.object({
    type: z.enum(['organization', 'person']),
    id: z.string(),
  }),
  target: z.object({
    type: z.literal('address'),
    id: z.string().nullable(),
  }),
})

export const EvidenceSummaryDtoSchema = z.object({
  supporting: z.number().int(),
  contradicting: z.number().int(),
  unknown: z.number().int(),
})

export const EvidenceSourceKindSchema = z.enum([
  'uploaded_document',
  'fiscal_nf3e',
  'fiscal_nfag',
  'public_registry',
])

export const VerificationMethodSchema = z.enum([
  'content_extraction',
  'official_qr_consultation',
  'official_xml_signature',
  'manual_review',
])

export const DocumentOutcomeSchema = z.enum([
  'authentic',
  'not_found',
  'invalid',
  'inconclusive',
  'unavailable',
  'unsupported',
])

export const MatchOutcomeSchema = z.enum(['matches', 'differs', 'not_extracted'])

export const EvidenceVerificationDtoSchema = z.object({
  status: z.enum(['completed', 'invalid', 'inconclusive', 'unsupported', 'unavailable']),
  method: VerificationMethodSchema,
  source: z.object({
    kind: EvidenceSourceKindSchema,
    id: z.string(),
    authority: z.string().nullable(),
    environment: z.enum(['production', 'homologation', 'local']),
  }),
  document: DocumentOutcomeSchema,
  address: MatchOutcomeSchema,
  holder: MatchOutcomeSchema,
  analysis_id: z.uuid(),
  analyzer: z.object({
    id: z.string(),
    version: z.string(),
  }),
  contract_version: z.string(),
  observed_at: z.iso.datetime(),
  limitations: z.array(z.string()),
  error_codes: z.array(z.string()),
  comparison: z.object({
    address: z.object({
      compared_fields: z.array(
        z.enum(['cep', 'uf', 'logradouro', 'numero', 'bairro', 'cidade', 'complemento']),
      ),
      reason_codes: z.array(z.string()),
    }),
    holder: z.object({
      reference: z.enum(['legal_name', 'trade_name', 'none']),
      reason_codes: z.array(z.string()),
    }),
  }),
})

/**
 * Leitura corrente da consulta fiscal materializada em `claim_evidence`
 * (`source = fiscal_nf3e`), no mesmo formato da verificação do documento
 * enviado. Expõe apenas o que o dashboard precisa: `document` (autenticidade),
 * `address`/`holder` (comparação) e `limitations`. O hash da referência, a URL
 * consultada, o IP resolvido e a resposta bruta NUNCA são expostos — eles
 * existem no `detail` persistido apenas para auditoria.
 */
export const FiscalVerificationDtoSchema = z.object({
  status: z.enum(['completed', 'not_found', 'invalid', 'inconclusive', 'unsupported', 'unavailable']),
  method: VerificationMethodSchema,
  source: z.object({
    kind: EvidenceSourceKindSchema,
    id: z.string(),
    authority: z.string().nullable(),
    environment: z.enum(['production', 'homologation', 'local']),
  }),
  document: DocumentOutcomeSchema,
  address: MatchOutcomeSchema,
  holder: MatchOutcomeSchema,
  adapter_version: z.string(),
  contract_version: z.string(),
  observed_at: z.iso.datetime(),
  limitations: z.array(z.string()),
  error_codes: z.array(z.string()),
})

export type FiscalVerificationDto = z.infer<typeof FiscalVerificationDtoSchema>

export const AssessmentExplanationDtoSchema = z.object({
  code: z.string(),
  message: z.string(),
  supporting_evidence: z.array(z.uuid()),
  contradicting_evidence: z.array(z.uuid()),
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
  claim: ClaimDtoSchema.nullable().optional(),
  evidence_summary: EvidenceSummaryDtoSchema.nullable().optional(),
  evidence_verification: EvidenceVerificationDtoSchema.nullable().optional(),
  fiscal_verification: FiscalVerificationDtoSchema.nullable().optional(),
  explanation: z.string().nullable(),
  explanation_detail: AssessmentExplanationDtoSchema.nullable().optional(),
  created_at: z.string(),
  expires_at: z.string(),
})

export const BatchItemSchema = z.object({
  type: DocTypeSchema,
  value: z.string().min(11).max(20),
})

export const BatchRequestSchema = z.object({
  items: z.array(BatchItemSchema).min(1).max(1000),
  mode: ValModeSchema.default('fast'),
  legal_basis: LegalBasisSchema,
})

export type BatchRequest = z.infer<typeof BatchRequestSchema>

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
export type EvidenceVerificationDto = z.infer<typeof EvidenceVerificationDtoSchema>
