import type {
  ValidationProgress,
  ValidationProgressStage,
  ValidationProgressStep,
  ValidationProgressStepStatus,
} from '@comprova/contracts'

/**
 * Entrada da derivação do progresso. Todos os campos vêm do estado durável que
 * o worker já grava:
 *
 * - `evidence_analysis.status/result` (F1.2: documento + referência fiscal);
 * - `claim_evidence` de `uploaded_document` (F1.3: verificação do comprovante);
 * - `validation.fiscal_reassessment` (F2.2b/F3: consulta/reavaliação);
 * - `claim_evidence` de `fiscal_nf3e` (resultado do autorizador).
 *
 * Não há etapa nova persistida: o progresso é uma projeção observável desses
 * estados. `skipped` significa que a etapa não se aplica (ex.: comprovante sem
 * referência fiscal), não que ela falhou.
 */
export interface ValidationProgressAnalysis {
  readonly status: string
  readonly fiscalReferenceStatus: string | null
  readonly documentStatus: string | null
}

export interface ValidationProgressVerification {
  readonly status: string
  readonly document: string
}

export interface ValidationProgressInput {
  readonly validationStatus: string
  readonly fiscalReassessment: string | null
  readonly analysis: ValidationProgressAnalysis | null
  readonly evidenceVerification: ValidationProgressVerification | null
  readonly fiscalVerification: ValidationProgressVerification | null
}

const step = (
  stage: ValidationProgressStage,
  status: ValidationProgressStepStatus,
): ValidationProgressStep => ({ stage, status })

const isTerminalAnalysis = (status: string | null): boolean =>
  status !== null && status !== 'pending' && status !== 'analyzing'

/**
 * Deriva o progresso real do fluxo. A ordem das etapas é a mesma do produto:
 *
 *   análise do comprovante → referência fiscal → autorizador →
 *   autenticidade → comparação das evidências
 *
 * `reading_document` cobre a análise (F1.2) e a verificação do comprovante
 * (F1.3). `reading_qr` cobre a obtenção/uso da referência fiscal extraída.
 * `consulting_provider` cobre a chamada ao `FiscalAdapter`; a existência da
 * evidência fiscal materializada já significa que a consulta terminou.
 * `verifying_authenticity` lê o resultado do autorizador; quando ele existe, a
 * autenticidade foi determinada (mesmo que o resultado seja `not_found`,
 * `invalid`, `inconclusive` ou `unsupported`). `comparing_evidence` é o
 * assessment que ainda pode estar rodando com `fiscal_reassessment = pending`.
 */
export const buildValidationProgress = (input: ValidationProgressInput): ValidationProgress | null => {
  const { analysis, evidenceVerification, fiscalVerification } = input
  if (
    analysis === null &&
    evidenceVerification === null &&
    fiscalVerification === null &&
    input.fiscalReassessment === null
  ) {
    return null
  }

  const analysisStatus = analysis?.status ?? null
  const analysisTerminal = isTerminalAnalysis(analysisStatus)
  const documentInvalid = analysisStatus === 'failed' || analysis?.documentStatus === 'invalid'
  const documentVerified = evidenceVerification !== null
  const referenceStatus = analysis?.fiscalReferenceStatus ?? null
  const hasReference = referenceStatus === 'found'
  const fiscalStarted = input.fiscalReassessment !== null || fiscalVerification !== null
  const providerUnavailable =
    fiscalVerification?.status === 'unavailable' || fiscalVerification?.document === 'unavailable'
  const validationFailed = input.validationStatus === 'failed' || input.validationStatus === 'expired'

  let readingDocument: ValidationProgressStepStatus
  if (documentInvalid) {
    readingDocument = 'failed'
  } else if (!analysisTerminal) {
    readingDocument = validationFailed ? 'failed' : 'in_progress'
  } else if (!documentVerified && !fiscalStarted) {
    // A análise terminou, mas a verificação F1.3 ainda não materializou: o
    // comprovante continua sendo processado.
    readingDocument = validationFailed ? 'failed' : 'in_progress'
  } else {
    readingDocument = 'completed'
  }

  let readingQr: ValidationProgressStepStatus
  if (readingDocument === 'failed') {
    readingQr = 'skipped'
  } else if (readingDocument !== 'completed') {
    readingQr = 'pending'
  } else if (hasReference) {
    // A referência já foi extraída; esta etapa representa o intervalo real em
    // que o worker ainda vai iniciar a consulta fiscal.
    readingQr = fiscalStarted ? 'completed' : 'in_progress'
  } else {
    readingQr = 'completed'
  }

  let consultingProvider: ValidationProgressStepStatus
  if (readingDocument === 'failed') {
    consultingProvider = 'skipped'
  } else if (readingDocument !== 'completed') {
    // Ainda não se sabe se há referência fiscal: as etapas fiscais ficam
    // aguardando, não "não aplicáveis".
    consultingProvider = 'pending'
  } else if (!hasReference) {
    consultingProvider = 'skipped'
  } else if (fiscalVerification !== null) {
    // `unavailable` significa que o autorizador não pôde ser consultado; a
    // validação em si preserva a semântica neutra do backend.
    consultingProvider = providerUnavailable ? 'failed' : 'completed'
  } else if (input.fiscalReassessment === 'pending') {
    consultingProvider = 'in_progress'
  } else if (validationFailed) {
    consultingProvider = 'failed'
  } else {
    consultingProvider = 'pending'
  }

  let verifyingAuthenticity: ValidationProgressStepStatus
  if (readingDocument === 'failed') {
    verifyingAuthenticity = 'skipped'
  } else if (readingDocument !== 'completed') {
    verifyingAuthenticity = 'pending'
  } else if (!hasReference) {
    verifyingAuthenticity = 'skipped'
  } else if (consultingProvider !== 'completed') {
    verifyingAuthenticity = 'pending'
  } else {
    verifyingAuthenticity = 'completed'
  }

  let comparingEvidence: ValidationProgressStepStatus
  if (readingDocument === 'failed') {
    comparingEvidence = 'skipped'
  } else if (readingDocument !== 'completed') {
    comparingEvidence = 'pending'
  } else if (!hasReference) {
    comparingEvidence = 'skipped'
  } else if (verifyingAuthenticity !== 'completed') {
    comparingEvidence = 'pending'
  } else if (input.fiscalReassessment === 'completed') {
    comparingEvidence = 'completed'
  } else if (input.fiscalReassessment === 'pending') {
    comparingEvidence = 'in_progress'
  } else if (validationFailed) {
    comparingEvidence = 'failed'
  } else {
    comparingEvidence = 'pending'
  }

  const steps: ValidationProgressStep[] = [
    step('reading_document', readingDocument),
    step('reading_qr', readingQr),
    step('consulting_provider', consultingProvider),
    step('verifying_authenticity', verifyingAuthenticity),
    step('comparing_evidence', comparingEvidence),
  ]

  // Uma validação que terminou em falha não deve deixar uma etapa "em
  // andamento" na tela. Marca a primeira etapa ainda ativa como falha e as
  // seguintes como não aplicáveis.
  if (validationFailed && !steps.some((item) => item.status === 'failed')) {
    const active = steps.findIndex((item) => item.status === 'in_progress' || item.status === 'pending')
    const activeStep = steps[active]
    if (activeStep !== undefined) {
      steps[active] = { stage: activeStep.stage, status: 'failed' }
    }
  }

  const firstFailed = steps.findIndex((item) => item.status === 'failed')
  if (firstFailed >= 0) {
    for (let index = firstFailed + 1; index < steps.length; index += 1) {
      const current = steps[index]
      if (current !== undefined && (current.status === 'pending' || current.status === 'in_progress')) {
        steps[index] = { ...current, status: 'skipped' }
      }
    }
  }

  const failed = steps.some((item) => item.status === 'failed') || validationFailed
  const completed = !failed && steps.every((item) => item.status === 'completed' || item.status === 'skipped')

  return {
    status: failed ? 'failed' : completed ? 'completed' : 'in_progress',
    steps,
  }
}
