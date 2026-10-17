// @vitest-environment jsdom
import '@/test/polyfills'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ValidationDto, ValidationSignal } from '@/api/client'
import { ValidationResult } from './validation-result'

afterEach(cleanup)

const NOW = '2026-10-17T12:00:00.000Z'
const VALIDATION_ID = 'abcd1234-5678-4abc-9def-000000000001'

const signal = (s: {
  checker: string
  stance: ValidationSignal['stance']
  detail?: Record<string, unknown>
}): ValidationSignal => ({
  checker: s.checker,
  checker_version: '1.0.0',
  stance: s.stance,
  strength: 0.6,
  confidence: 0.9,
  source: 'receita',
  observed_at: NOW,
  ttl_seconds: 86_400,
  detail: s.detail ?? {},
  evidence_id: null,
})

const validation: ValidationDto = {
  validation_id: VALIDATION_ID,
  status: 'completed',
  verdict: 'CONFIRMED_COMMERCIAL',
  confidence: 0.9,
  score: 0.62,
  policy_version: '2026.11.1',
  address: { building_key: 'bk', country: 'BR', uf: 'SP', geo_precision: 'ROOFTOP' },
  signals: [
    signal({ checker: 'document_integrity', stance: 'supports' }),
    signal({
      checker: 'registry_status',
      stance: 'supports',
      detail: { situacao: 'ativa', data_abertura: '2019-06-20' },
    }),
    signal({ checker: 'country_check', stance: 'supports', detail: { country: 'BR', uf: 'SP' } }),
    signal({
      checker: 'cep_consistency',
      stance: 'supports',
      detail: { cep: '01310100', uf: 'SP', localidade: 'São Paulo' },
    }),
    signal({
      checker: 'cnefe_match',
      stance: 'neutral',
      detail: { match: 'street_only', especie: 1, residential_hint: true },
    }),
    signal({ checker: 'geocode_consensus', stance: 'contradicts', detail: { dispersion_m: 420 } }),
    signal({ checker: 'cotenancy', stance: 'unknown', detail: { reason: 'no_profile' } }),
  ],
  claim: {
    id: 'claim-1',
    type: 'business_registered_address',
    subject: { type: 'organization', id: 'subject-1' },
    target: { type: 'address', id: 'address-1' },
  },
  explanation: null,
  explanation_detail: {
    code: 'CONFIRMED',
    message: 'Endereço compatível com a atividade.',
    supporting_evidence: [],
    contradicting_evidence: [],
  },
  address_unavailable_reason: null,
  created_at: NOW,
  expires_at: '2026-11-16T12:00:00.000Z',
}

const panelId = (checker: string): string => `sig-${VALIDATION_ID}-${checker}-panel`

const rowButton = (checker: string): HTMLElement => {
  const row = document.getElementById(`sig-${VALIDATION_ID}-${checker}`)
  if (row === null) throw new Error(`linha de evidência ausente para ${checker}`)
  return within(row).getByRole('button')
}

describe('ValidationResult', () => {
  it('comunica o estado por texto, não apenas por cor', () => {
    render(<ValidationResult validation={validation} />)

    expect(screen.getByRole('heading', { name: 'Comercial confirmado' })).toBeTruthy()
    expect(screen.getByText('Endereço compatível com a atividade.')).toBeTruthy()
    expect(screen.getByText('Endereço de registro da empresa')).toBeTruthy()
    expect(screen.getByText('alta')).toBeTruthy()
    expect(screen.getByText('+0.62')).toBeTruthy()
    // Anel de confiança exposto como imagem com nome acessível.
    expect(screen.getByRole('img', { name: 'Confiança alta: 90%' })).toBeTruthy()
    // Rótulos de postura legíveis ao lado dos ícones (nunca só a cor).
    expect(screen.getAllByText('A favor')).toHaveLength(4)
    expect(screen.getAllByText('Contra').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Neutro').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Sem dados').length).toBeGreaterThanOrEqual(1)
  })

  it('resume as evidências e lista os pontos de atenção', () => {
    render(<ValidationResult validation={validation} />)

    expect(screen.getByRole('img', { name: '4 a favor, 1 neutro, 1 contra, 1 sem dados' })).toBeTruthy()
    expect(screen.getByText('Pontos de atenção (2)')).toBeTruthy()
    expect(screen.getByText(/Provedores de mapa divergem em 420 m/)).toBeTruthy()
  })

  it('agrupa as evidências por categoria e permite abrir o detalhe', async () => {
    const user = userEvent.setup()
    render(<ValidationResult validation={validation} />)

    const registry = screen.getByRole('group', { name: 'Cadastro' })
    expect(within(registry).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('group', { name: 'Ocupação do imóvel' })).toBeTruthy()

    const button = rowButton('document_integrity')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-controls')).toBe(panelId('document_integrity'))

    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(panelId('document_integrity'))).not.toBeNull()

    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(panelId('document_integrity'))).toBeNull()
  })

  it('expande todas as evidências com defaultExpanded', () => {
    render(<ValidationResult validation={validation} defaultExpanded />)

    for (const s of validation.signals) {
      expect(document.getElementById(panelId(s.checker))).not.toBeNull()
    }
  })

  it('recolhe o resultado mantendo o controle acessível', async () => {
    const user = userEvent.setup()
    render(<ValidationResult validation={validation} />)

    await user.click(screen.getByRole('button', { name: 'Recolher resultado' }))

    expect(screen.queryByText('Resumo das evidências')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expandir resultado' }).getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('sinaliza resultado parcial e veredito inconclusivo', () => {
    render(
      <ValidationResult
        validation={{ ...validation, status: 'queued', verdict: 'INSUFFICIENT_EVIDENCE', confidence: 0.3 }}
      />,
    )

    expect(screen.getByText('resultado parcial')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Evidência insuficiente' })).toBeTruthy()
    expect(screen.getByText('O enriquecimento ainda pode alterar este veredito.')).toBeTruthy()
  })

  it('explica quando o CNPJ não está na competência carregada', () => {
    render(
      <ValidationResult validation={{ ...validation, address_unavailable_reason: 'cnpj_not_in_snapshot' }} />,
    )

    expect(
      screen.getByText(
        'Este CNPJ não está na competência carregada da Receita. As verificações que dependem do cadastro ficam sem dados até a próxima carga.',
      ),
    ).toBeTruthy()
  })
})
