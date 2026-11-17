/**
 * Mapeamento puro de estado da validação para a interface do Verifier.
 *
 * Regras da taxonomia (ADR-0045/ADR-0040):
 *  - O resultado exibido é SEMPRE o assessment do backend; o documento
 *    recebido não é aprovação.
 *  - `unavailable`, `unsupported`, `inconclusive`, `not_extracted` e `unknown`
 *    NUNCA são apresentados como reprovação ou fraude (variantes neutras).
 *  - Enquanto houver processamento ou reavaliação pendente, o resultado antigo
 *    não é apresentado como definitivo.
 */

export type ValidationStatus =
  'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'expired' | 'blocked_quota'
export type Verdict =
  | 'CONFIRMED_COMMERCIAL'
  | 'SHARED_VIRTUAL'
  | 'OCCUPIED_BY_OTHER_ENTITY'
  | 'RESIDENTIAL'
  | 'NOT_FOUND'
  | 'FOREIGN'
  | 'INCONSISTENT'
  | 'INSUFFICIENT_EVIDENCE'
export type ProgressStatus = 'in_progress' | 'completed' | 'failed'
export type BadgeVariant =
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline'

/** Estados de interface da validação (listagem e detalhe). */
export type ValidationUiState =
  | 'awaiting_document' // aguardando envio do documento
  | 'document_received' // documento recebido, processamento ainda não iniciado
  | 'processing' // processamento em curso (análise/verificação/consulta fiscal)
  | 'completed' // concluído com veredito
  | 'inconclusive' // concluído sem evidência suficiente
  | 'failed' // falha de processamento
  | 'expired' // validação expirada (grafo removido pela retenção)

export interface ValidationUiInput {
  readonly status: ValidationStatus
  readonly verdict: Verdict | null
  readonly hasCustomerDocument: boolean
  readonly progressStatus?: ProgressStatus | null
  /** Reavaliação fiscal pendente (F2.2b): resultado antigo não é definitivo. */
  readonly fiscalReassessment?: string | null
}

const ACTIVE_STATUSES: ReadonlySet<ValidationStatus> = new Set([
  'queued',
  'running',
  'partial',
  'blocked_quota',
])

export const validationUiState = (input: ValidationUiInput): ValidationUiState => {
  if (input.status === 'failed') return 'failed'
  if (input.status === 'expired') return 'expired'
  if (input.progressStatus === 'failed') return 'failed'
  // Trabalho pendente (processamento em curso ou reavaliação fiscal agendada)
  // vem ANTES dos vereditos: um veredito retido não é definitivo enquanto
  // houver reprocessamento.
  if (input.progressStatus === 'in_progress' || input.fiscalReassessment === 'pending') {
    return 'processing'
  }
  if (input.verdict === 'INSUFFICIENT_EVIDENCE') return 'inconclusive'
  if (input.verdict !== null) return 'completed'
  if (ACTIVE_STATUSES.has(input.status)) {
    if (!input.hasCustomerDocument) return 'awaiting_document'
    // Recibo existe e nada foi processado ainda (progress null): documento
    // recebido. Com progresso em curso permanece em processamento.
    if (input.progressStatus === null || input.progressStatus === undefined) return 'document_received'
    return 'processing'
  }
  return 'processing'
}

export interface ValidationUiBadge {
  readonly state: ValidationUiState
  readonly label: string
  readonly variant: BadgeVariant
}

const VERDICT_LABELS: Record<Verdict, string> = {
  CONFIRMED_COMMERCIAL: 'Comercial confirmado',
  SHARED_VIRTUAL: 'Compartilhado/virtual',
  OCCUPIED_BY_OTHER_ENTITY: 'Ocupado por outra entidade',
  RESIDENTIAL: 'Residencial confirmado',
  NOT_FOUND: 'Endereço não encontrado',
  FOREIGN: 'Estrangeiro',
  INCONSISTENT: 'Inconsistente',
  INSUFFICIENT_EVIDENCE: 'Inconclusivo',
}

export const validationUiBadge = (input: ValidationUiInput): ValidationUiBadge => {
  const state = validationUiState(input)
  switch (state) {
    case 'awaiting_document':
      return { state, label: 'Aguardando documento', variant: 'secondary' }
    case 'document_received':
      return { state, label: 'Documento recebido', variant: 'info' }
    case 'processing':
      return { state, label: 'Em processamento', variant: 'warning' }
    case 'completed':
      return {
        state,
        label: VERDICT_LABELS[input.verdict as Verdict],
        variant: 'success',
      }
    case 'inconclusive':
      // Inconclusivo NÃO é reprovação: variante neutra.
      return { state, label: 'Inconclusivo', variant: 'secondary' }
    case 'failed':
      return { state, label: 'Falha no processamento', variant: 'destructive' }
    case 'expired':
      return { state, label: 'Expirada', variant: 'outline' }
  }
}

/** Rótulo de um veredito concluído (usado no detalhe). */
export const verdictLabel = (verdict: Verdict): string => VERDICT_LABELS[verdict]

/** Status do processamento (coluna `status` da validation) para exibição. */
export const statusLabel = (status: ValidationStatus): string => {
  switch (status) {
    case 'queued':
      return 'Na fila'
    case 'running':
      return 'Em execução'
    case 'partial':
      return 'Parcial'
    case 'completed':
      return 'Concluída'
    case 'failed':
      return 'Falhou'
    case 'expired':
      return 'Expirada'
    case 'blocked_quota':
      return 'Bloqueada por cota'
  }
}

/** Rótulo/variante das dimensões de verificação (F1.3) e consulta fiscal. */
export type DimensionOutcome =
  | 'authentic'
  | 'not_found'
  | 'invalid'
  | 'inconclusive'
  | 'unavailable'
  | 'unsupported'
  | 'matches'
  | 'differs'
  | 'not_extracted'

export const dimensionBadge = (outcome: DimensionOutcome): { label: string; variant: BadgeVariant } => {
  switch (outcome) {
    case 'authentic':
      return { label: 'Autêntico', variant: 'success' }
    case 'matches':
      return { label: 'Compatível', variant: 'success' }
    case 'differs':
      return { label: 'Divergente', variant: 'warning' }
    case 'invalid':
      return { label: 'Inválido', variant: 'destructive' }
    case 'inconclusive':
      // Neutro: inconclusivo não é reprovação.
      return { label: 'Inconclusivo', variant: 'secondary' }
    case 'unavailable':
      return { label: 'Indisponível', variant: 'secondary' }
    case 'unsupported':
      return { label: 'Não suportado', variant: 'secondary' }
    case 'not_found':
      return { label: 'Não encontrado', variant: 'secondary' }
    case 'not_extracted':
      return { label: 'Não extraído', variant: 'secondary' }
  }
}

/**
 * Indica se o detalhe deve continuar sendo atualizado (polling): há
 * processamento ou reavaliação pendente.
 *
 * Uma validation `queued` SEM documento não está em processamento — está
 * aguardando envio; o polling e o aviso de "em processamento" só valem
 * depois do intake do documento (`has_customer_document`).
 */
export const isProcessing = (input: {
  readonly status: ValidationStatus
  readonly hasCustomerDocument: boolean
  readonly progressStatus?: ProgressStatus | null
  readonly fiscalReassessment?: string | null
}): boolean => {
  if (!input.hasCustomerDocument) return false
  // Estados terminais nunca são processamento ativo.
  if (input.status === 'failed' || input.status === 'expired') return false
  if (input.status === 'queued' || input.status === 'running' || input.status === 'partial') return true
  if (input.progressStatus === 'in_progress') return true
  // F2.2b: reavaliação fiscal pendente/agendada mantém o acompanhamento.
  return input.fiscalReassessment === 'pending'
}
