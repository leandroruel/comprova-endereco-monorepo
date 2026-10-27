import { describe, expect, it } from 'vitest'
import {
  buildValidationProgress,
  type ValidationProgressAnalysis,
  type ValidationProgressInput,
} from '../src/modules/validations/validation-progress.js'

const analysis = (overrides: Partial<ValidationProgressAnalysis> = {}): ValidationProgressAnalysis => ({
  status: 'completed',
  fiscalReferenceStatus: 'found',
  documentStatus: 'analyzed',
  ...overrides,
})

const evidenceVerification = { status: 'completed', document: 'authentic' }
const fiscalVerification = { status: 'completed', document: 'authentic' }

const input = (overrides: Partial<ValidationProgressInput> = {}): ValidationProgressInput => ({
  validationStatus: 'partial',
  fiscalReassessment: null,
  analysis: null,
  evidenceVerification: null,
  fiscalVerification: null,
  ...overrides,
})

const statusOf = (value: ReturnType<typeof buildValidationProgress>, stage: string): string | null =>
  value?.steps.find((step) => step.stage === stage)?.status ?? null

describe('buildValidationProgress', () => {
  it('não inventa progresso quando o fluxo de comprovante ainda não começou', () => {
    expect(buildValidationProgress(input())).toBeNull()
  })

  it('estado inicial: análise pendente e etapas fiscais aguardando', () => {
    const progress = buildValidationProgress(
      input({ analysis: analysis({ status: 'pending', fiscalReferenceStatus: null }) }),
    )
    expect(progress?.status).toBe('in_progress')
    expect(statusOf(progress, 'reading_document')).toBe('in_progress')
    expect(statusOf(progress, 'reading_qr')).toBe('pending')
    expect(statusOf(progress, 'consulting_provider')).toBe('pending')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('pending')
    expect(statusOf(progress, 'comparing_evidence')).toBe('pending')
  })

  it('lendo documento enquanto a análise ainda não terminou', () => {
    const progress = buildValidationProgress(
      input({ analysis: analysis({ status: 'analyzing', fiscalReferenceStatus: null }) }),
    )
    expect(statusOf(progress, 'reading_document')).toBe('in_progress')
    expect(statusOf(progress, 'reading_qr')).toBe('pending')
  })

  it('lendo documento também cobre a verificação F1.3 antes de materializar', () => {
    const progress = buildValidationProgress(input({ analysis: analysis(), evidenceVerification: null }))
    expect(statusOf(progress, 'reading_document')).toBe('in_progress')
    expect(statusOf(progress, 'reading_qr')).toBe('pending')
  })

  it('lendo QR Code: documento verificado e referência encontrada, sem consulta iniciada', () => {
    const progress = buildValidationProgress(input({ analysis: analysis(), evidenceVerification }))
    expect(statusOf(progress, 'reading_document')).toBe('completed')
    expect(statusOf(progress, 'reading_qr')).toBe('in_progress')
    expect(statusOf(progress, 'consulting_provider')).toBe('pending')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('pending')
    expect(statusOf(progress, 'comparing_evidence')).toBe('pending')
  })

  it('consultando provedor fiscal com reavaliação pendente e sem evidência fiscal', () => {
    const progress = buildValidationProgress(
      input({
        analysis: analysis(),
        evidenceVerification,
        fiscalReassessment: 'pending',
      }),
    )
    expect(statusOf(progress, 'reading_document')).toBe('completed')
    expect(statusOf(progress, 'reading_qr')).toBe('completed')
    expect(statusOf(progress, 'consulting_provider')).toBe('in_progress')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('pending')
    expect(statusOf(progress, 'comparing_evidence')).toBe('pending')
  })

  it('comprovando autenticidade concluída e comparação em andamento', () => {
    const progress = buildValidationProgress(
      input({
        analysis: analysis(),
        evidenceVerification,
        fiscalReassessment: 'pending',
        fiscalVerification,
      }),
    )
    expect(statusOf(progress, 'consulting_provider')).toBe('completed')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('completed')
    expect(statusOf(progress, 'comparing_evidence')).toBe('in_progress')
    expect(progress?.status).toBe('in_progress')
  })

  it('conclusão: todas as etapas aplicáveis concluídas', () => {
    const progress = buildValidationProgress(
      input({
        validationStatus: 'completed',
        analysis: analysis(),
        evidenceVerification,
        fiscalReassessment: 'completed',
        fiscalVerification,
      }),
    )
    expect(progress?.status).toBe('completed')
    expect(progress?.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ])
  })

  it('provedor indisponível falha a consulta sem virar documento inválido', () => {
    const progress = buildValidationProgress(
      input({
        analysis: analysis(),
        evidenceVerification,
        fiscalReassessment: 'completed',
        fiscalVerification: { status: 'unavailable', document: 'unavailable' },
      }),
    )
    expect(progress?.status).toBe('failed')
    expect(statusOf(progress, 'reading_document')).toBe('completed')
    expect(statusOf(progress, 'reading_qr')).toBe('completed')
    expect(statusOf(progress, 'consulting_provider')).toBe('failed')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('skipped')
    expect(statusOf(progress, 'comparing_evidence')).toBe('skipped')
  })

  it('documento inválido falha em Lendo documento e não inventa etapas fiscais', () => {
    const progress = buildValidationProgress(
      input({
        validationStatus: 'failed',
        analysis: analysis({
          status: 'inconclusive',
          documentStatus: 'invalid',
          fiscalReferenceStatus: null,
        }),
      }),
    )
    expect(progress?.status).toBe('failed')
    expect(statusOf(progress, 'reading_document')).toBe('failed')
    expect(statusOf(progress, 'reading_qr')).toBe('skipped')
    expect(statusOf(progress, 'consulting_provider')).toBe('skipped')
  })

  it('análise failed falha em Lendo documento', () => {
    const progress = buildValidationProgress(
      input({
        validationStatus: 'failed',
        analysis: analysis({ status: 'failed', fiscalReferenceStatus: null, documentStatus: 'unavailable' }),
      }),
    )
    expect(progress?.status).toBe('failed')
    expect(statusOf(progress, 'reading_document')).toBe('failed')
  })

  it('sem QR conclui o fluxo existente e marca etapas fiscais como não aplicáveis', () => {
    const progress = buildValidationProgress(
      input({
        validationStatus: 'completed',
        analysis: analysis({ fiscalReferenceStatus: 'not_found' }),
        evidenceVerification,
      }),
    )
    expect(progress?.status).toBe('completed')
    expect(statusOf(progress, 'reading_document')).toBe('completed')
    expect(statusOf(progress, 'reading_qr')).toBe('completed')
    expect(statusOf(progress, 'consulting_provider')).toBe('skipped')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('skipped')
    expect(statusOf(progress, 'comparing_evidence')).toBe('skipped')
  })

  it('validação failed sem etapa concluída marca a etapa ativa como falha', () => {
    const progress = buildValidationProgress(
      input({
        validationStatus: 'failed',
        analysis: analysis(),
        evidenceVerification,
        fiscalReassessment: 'pending',
      }),
    )
    expect(progress?.status).toBe('failed')
    expect(statusOf(progress, 'consulting_provider')).toBe('failed')
    expect(statusOf(progress, 'verifying_authenticity')).toBe('skipped')
    expect(statusOf(progress, 'comparing_evidence')).toBe('skipped')
  })

  it('resultado partial não impede o progresso de concluir quando o fluxo terminou', () => {
    const progress = buildValidationProgress(
      input({
        validationStatus: 'partial',
        analysis: analysis({ fiscalReferenceStatus: 'unsupported' }),
        evidenceVerification,
      }),
    )
    expect(progress?.status).toBe('completed')
    expect(statusOf(progress, 'reading_document')).toBe('completed')
    expect(statusOf(progress, 'reading_qr')).toBe('completed')
    expect(statusOf(progress, 'consulting_provider')).toBe('skipped')
  })
})
