import { describe, expect, it } from 'vitest'
import { holderProcessingLabel, holderRequestUiBadge } from './validations-state'

/**
 * Estado da solicitação real do Holder (`holder_information_request`) na
 * listagem do Verifier. Os estados vêm do banco; a UI apenas os apresenta.
 * Estados terminais nunca são convertidos em "aguardando" e o processamento
 * documental é distinto do estado da solicitação.
 */
describe('holderRequestUiBadge', () => {
  const input = {
    requestState: 'pending' as const,
    consentGranted: false,
    documentsReceived: false,
    documentProcessingState: null,
  }

  it('sem solicitação vinculada', () => {
    expect(holderRequestUiBadge({ ...input, requestState: null })).toEqual({
      label: 'Sem solicitação',
      variant: 'outline',
    })
  })

  it('pendente distingue consentimento de documentos', () => {
    expect(holderRequestUiBadge(input).label).toBe('Aguardando consentimento')
    expect(holderRequestUiBadge({ ...input, consentGranted: true }).label).toBe('Aguardando documentos')
    expect(holderRequestUiBadge({ ...input, consentGranted: true, documentsReceived: true }).label).toBe(
      'Documentos recebidos',
    )
  })

  it('em andamento segue a mesma regra', () => {
    expect(holderRequestUiBadge({ ...input, requestState: 'in_progress' }).label).toBe(
      'Aguardando consentimento',
    )
  })

  it('estados terminais são exibidos como tais', () => {
    expect(holderRequestUiBadge({ ...input, requestState: 'cancelled' })).toEqual({
      label: 'Cancelada',
      variant: 'outline',
    })
    expect(holderRequestUiBadge({ ...input, requestState: 'expired' })).toEqual({
      label: 'Expirada',
      variant: 'outline',
    })
  })

  it('concluída reflete o processamento documental, sem confundir com o resultado', () => {
    const completed = { ...input, requestState: 'completed' as const, documentsReceived: true }
    expect(holderRequestUiBadge(completed).label).toBe('Enviada')
    expect(holderRequestUiBadge({ ...completed, documentProcessingState: 'awaiting' }).label).toBe(
      'Processando envio',
    )
    expect(holderRequestUiBadge({ ...completed, documentProcessingState: 'processing' }).label).toBe(
      'Processando envio',
    )
    expect(holderRequestUiBadge({ ...completed, documentProcessingState: 'processed' })).toEqual({
      label: 'Processado',
      variant: 'success',
    })
    expect(holderRequestUiBadge({ ...completed, documentProcessingState: 'partial' }).label).toBe(
      'Processamento parcial',
    )
    expect(holderRequestUiBadge({ ...completed, documentProcessingState: 'failed' })).toEqual({
      label: 'Falha no processamento',
      variant: 'destructive',
    })
  })

  it('rótulos de processamento documental', () => {
    expect(holderProcessingLabel(null)).toBe('—')
    expect(holderProcessingLabel('awaiting')).toBe('Aguardando processamento')
    expect(holderProcessingLabel('processing')).toBe('Em processamento')
    expect(holderProcessingLabel('processed')).toBe('Processado')
    expect(holderProcessingLabel('partial')).toBe('Parcial')
    expect(holderProcessingLabel('failed')).toBe('Falhou')
  })
})
