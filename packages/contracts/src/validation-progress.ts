import { z } from 'zod'

/**
 * Progresso observável do fluxo de validação com comprovante.
 *
 * Os nomes das etapas são internos e estáveis; a tradução para linguagem do
 * usuário fica no dashboard. O backend expõe apenas o que já está persistido
 * (análise, verificação do documento, consulta fiscal e reavaliação), sem
 * criar uma nova máquina de estados.
 */
export const VALIDATION_PROGRESS_STAGES = [
  'reading_document',
  'reading_qr',
  'consulting_provider',
  'verifying_authenticity',
  'comparing_evidence',
] as const

export const ValidationProgressStageSchema = z.enum(VALIDATION_PROGRESS_STAGES)
export type ValidationProgressStage = z.infer<typeof ValidationProgressStageSchema>

export const VALIDATION_PROGRESS_STEP_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
] as const

export const ValidationProgressStepStatusSchema = z.enum(VALIDATION_PROGRESS_STEP_STATUSES)
export type ValidationProgressStepStatus = z.infer<typeof ValidationProgressStepStatusSchema>

export const ValidationProgressStepSchema = z.object({
  stage: ValidationProgressStageSchema,
  status: ValidationProgressStepStatusSchema,
})

export type ValidationProgressStep = z.infer<typeof ValidationProgressStepSchema>

export const VALIDATION_PROGRESS_STATUSES = ['in_progress', 'completed', 'failed'] as const

export const ValidationProgressStatusSchema = z.enum(VALIDATION_PROGRESS_STATUSES)
export type ValidationProgressStatus = z.infer<typeof ValidationProgressStatusSchema>

export const ValidationProgressSchema = z.object({
  status: ValidationProgressStatusSchema,
  steps: z.array(ValidationProgressStepSchema),
})

export type ValidationProgress = z.infer<typeof ValidationProgressSchema>
