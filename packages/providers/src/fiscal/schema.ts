import {
  DOCUMENT_OUTCOMES,
  FISCAL_SOURCE_IDS,
  MATCH_OUTCOMES,
  VERIFICATION_ENVIRONMENTS,
  VERIFICATION_METHODS,
  type FiscalVerificationResult,
} from '@comprova/core'
import { z } from 'zod'

/**
 * F2.1 — validação da saída do adapter fiscal antes da materialização.
 *
 * O objeto é `strip` por padrão: campos não previstos (por exemplo
 * `trust_score`, `approved` ou `final_score`) não são propagados para
 * `claim_evidence`. O materializador persiste apenas o contrato normalizado.
 */
const validDate = (value: Date): boolean => !Number.isNaN(value.getTime())

export const fiscalVerificationResultSchema = z.object({
  source: z.enum(FISCAL_SOURCE_IDS),
  adapterVersion: z.string().min(1),
  method: z.enum(VERIFICATION_METHODS),
  environment: z.enum(VERIFICATION_ENVIRONMENTS),
  document: z.enum(DOCUMENT_OUTCOMES),
  address: z.enum(MATCH_OUTCOMES),
  holder: z.enum(MATCH_OUTCOMES),
  issuer: z.string().nullable(),
  documentId: z.string().nullable(),
  issuedAt: z.date().refine(validDate, 'data de emissão inválida').nullable(),
  observedAt: z.date().refine(validDate, 'data de observação inválida'),
  limitations: z.array(z.string()),
  errorCodes: z.array(z.string()),
  artifact: z
    .object({
      artifactId: z.uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  audit: z.object({
    requestedUrl: z.string().nullable(),
    resolvedIp: z.string().nullable(),
    responseStatus: z.number().int().nullable(),
    responseSha256: z.string().nullable(),
  }),
}) satisfies z.ZodType<FiscalVerificationResult>
