import { describe, expect, it } from 'vitest'
import {
  dimensionBadge,
  isProcessing,
  validationUiBadge,
  validationUiState,
  type ValidationUiInput,
} from './validations-state.js'

/**
 * Estados de interface da validação (PR #74). Regras: estados intermediários
 * distintos; inconclusivo NUNCA é reprovação; resultado antigo não é
 * definitivo enquanto houver processamento/reavaliação pendente.
 */
const base = (overrides: Partial<ValidationUiInput>): ValidationUiInput => ({
  status: 'running',
  verdict: null,
  hasCustomerDocument: false,
  progressStatus: null,
  ...overrides,
})

describe('validationUiState', () => {
  it('aguardando envio do documento quando não há recibo', () => {
    expect(validationUiState(base({ status: 'queued' }))).toBe('awaiting_document')
    expect(validationUiState(base({ status: 'running' }))).toBe('awaiting_document')
  })

  it('documento recebido quando há recibo e o processamento ainda não começou', () => {
    expect(
      validationUiState(base({ status: 'running', hasCustomerDocument: true, progressStatus: null })),
    ).toBe('document_received')
  })

  it('processamento enquanto análise/verificação/consulta fiscal estão em curso', () => {
    expect(
      validationUiState(
        base({ status: 'running', hasCustomerDocument: true, progressStatus: 'in_progress' }),
      ),
    ).toBe('processing')
  })

  it('concluído apenas com veredito definitivo', () => {
    expect(
      validationUiState(base({ status: 'completed', verdict: 'RESIDENTIAL', hasCustomerDocument: true })),
    ).toBe('completed')
  })

  it('inconclusivo (INSUFFICIENT_EVIDENCE) é estado próprio, não reprovação', () => {
    const badge = validationUiBadge(
      base({ status: 'completed', verdict: 'INSUFFICIENT_EVIDENCE', hasCustomerDocument: true }),
    )
    expect(validationUiState(base({ status: 'completed', verdict: 'INSUFFICIENT_EVIDENCE' }))).toBe(
      'inconclusive',
    )
    expect(badge.variant).not.toBe('destructive')
    expect(badge.label.toLowerCase()).not.toContain('reprovad')
    expect(badge.label.toLowerCase()).not.toContain('fraude')
  })

  it('falha de processamento (status e progresso failed)', () => {
    expect(validationUiState(base({ status: 'failed' }))).toBe('failed')
    expect(
      validationUiState(base({ status: 'running', hasCustomerDocument: true, progressStatus: 'failed' })),
    ).toBe('failed')
  })

  it('expirada é estado próprio (não vira falha nem conclusão)', () => {
    expect(validationUiState(base({ status: 'expired', hasCustomerDocument: true }))).toBe('expired')
    expect(validationUiBadge(base({ status: 'expired', hasCustomerDocument: true })).variant).toBe('outline')
  })

  it('reavaliação fiscal pendente mantém o resultado em processamento', () => {
    expect(
      isProcessing({ status: 'completed', progressStatus: 'completed', fiscalReassessment: 'pending' }),
    ).toBe(true)
    expect(isProcessing({ status: 'completed', progressStatus: 'completed', fiscalReassessment: null })).toBe(
      false,
    )
  })
})

describe('dimensionBadge', () => {
  it('estados neutros da taxonomia NUNCA aparecem como reprovação ou fraude', () => {
    for (const outcome of [
      'inconclusive',
      'unavailable',
      'unsupported',
      'not_extracted',
      'not_found',
    ] as const) {
      const badge = dimensionBadge(outcome)
      expect(badge.variant).not.toBe('destructive')
      expect(badge.variant).not.toBe('warning')
      expect(badge.label.toLowerCase()).not.toContain('reprovad')
      expect(badge.label.toLowerCase()).not.toContain('fraude')
    }
  })

  it('resultados reais mantêm a semântica', () => {
    expect(dimensionBadge('authentic')).toMatchObject({ variant: 'success' })
    expect(dimensionBadge('matches')).toMatchObject({ variant: 'success' })
    expect(dimensionBadge('differs')).toMatchObject({ variant: 'warning' })
    expect(dimensionBadge('invalid')).toMatchObject({ variant: 'destructive' })
  })
})

describe('validationUiBadge', () => {
  it('estados intermediários têm rótulos distintos', () => {
    const labels = [
      validationUiBadge(base({ status: 'queued' })).label,
      validationUiBadge(base({ status: 'running', hasCustomerDocument: true })).label,
      validationUiBadge(base({ status: 'running', hasCustomerDocument: true, progressStatus: 'in_progress' }))
        .label,
    ]
    expect(new Set(labels).size).toBe(3)
  })

  it('concluído apresenta o veredito do assessment, não o recebimento do documento', () => {
    const badge = validationUiBadge(
      base({ status: 'completed', verdict: 'RESIDENTIAL', hasCustomerDocument: true }),
    )
    expect(badge.state).toBe('completed')
    expect(badge.label).toBe('Residencial confirmado')
    expect(badge.variant).toBe('success')
  })
})
