import type { Locator } from '@vitest/browser/context'
import { page } from '@vitest/browser/context'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ValidationDto, ValidationSignal } from '@/api/client'
import { ValidationResult } from './validation-result'

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

const rowButton = (checker: string): Locator => {
  const row = document.getElementById(`sig-${VALIDATION_ID}-${checker}`)
  if (row === null) throw new Error(`linha de evidência ausente para ${checker}`)
  return page.elementLocator(row).getByRole('button')
}

describe('ValidationResult', () => {
  it('comunica o estado por texto, não apenas por cor', async () => {
    render(<ValidationResult validation={validation} />)

    await expect.element(page.getByRole('heading', { name: 'Comercial confirmado' })).toBeVisible()
    await expect
      .element(page.getByText('Endereço compatível com a atividade.', { exact: true }))
      .toBeVisible()
    await expect.element(page.getByText('Endereço de registro da empresa', { exact: true })).toBeVisible()
    await expect.element(page.getByText('alta', { exact: true })).toBeVisible()
    await expect.element(page.getByText('+0.62', { exact: true })).toBeVisible()
    // Anel de confiança exposto como imagem com nome acessível.
    await expect.element(page.getByRole('img', { name: 'Confiança alta: 90%' })).toBeVisible()
    // Rótulos de postura legíveis ao lado dos ícones (nunca só a cor).
    expect(page.getByText('A favor', { exact: true }).elements()).toHaveLength(4)
    expect(page.getByText('Contra', { exact: true }).elements().length).toBeGreaterThanOrEqual(1)
    expect(page.getByText('Neutro', { exact: true }).elements().length).toBeGreaterThanOrEqual(1)
    expect(page.getByText('Sem dados', { exact: true }).elements().length).toBeGreaterThanOrEqual(1)
  })

  it('resume as evidências e lista os pontos de atenção', async () => {
    render(<ValidationResult validation={validation} />)

    // A barra de distribuição é só cor: sem a folha de estilo no teste ela não
    // tem caixa própria, então o alvo é a presença (e o nome acessível), não a
    // pintura na tela.
    await expect
      .element(page.getByRole('img', { name: '4 a favor, 1 neutro, 1 contra, 1 sem dados' }))
      .toBeInTheDocument()
    await expect.element(page.getByText('Pontos de atenção (2)', { exact: true })).toBeVisible()
    await expect.element(page.getByText(/Provedores de mapa divergem em 420 m/)).toBeVisible()
  })

  it('agrupa as evidências por categoria e permite abrir o detalhe', async () => {
    render(<ValidationResult validation={validation} />)

    const registry = page.getByRole('group', { name: 'Cadastro' })
    await expect.element(registry).toBeVisible()
    expect(registry.getByRole('listitem').elements()).toHaveLength(3)
    await expect.element(page.getByRole('group', { name: 'Ocupação do imóvel' })).toBeVisible()

    const button = rowButton('document_integrity')
    await expect.element(button).toHaveAttribute('aria-expanded', 'false')
    await expect.element(button).toHaveAttribute('aria-controls', panelId('document_integrity'))

    await button.click()
    await expect.element(button).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => document.getElementById(panelId('document_integrity'))).not.toBeNull()

    await button.click()
    await expect.element(button).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => document.getElementById(panelId('document_integrity'))).toBeNull()
  })

  it('expande todas as evidências com defaultExpanded', async () => {
    render(<ValidationResult validation={validation} defaultExpanded />)

    for (const s of validation.signals) {
      await expect.poll(() => document.getElementById(panelId(s.checker))).not.toBeNull()
    }
  })

  it('recolhe o resultado mantendo o controle acessível', async () => {
    render(<ValidationResult validation={validation} />)

    await page.getByRole('button', { name: 'Recolher resultado' }).click()

    await expect.element(page.getByText('Resumo das evidências', { exact: true })).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Expandir resultado' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('sinaliza resultado parcial e veredito inconclusivo', async () => {
    render(
      <ValidationResult
        validation={{ ...validation, status: 'queued', verdict: 'INSUFFICIENT_EVIDENCE', confidence: 0.3 }}
      />,
    )

    await expect.element(page.getByText('resultado parcial', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('heading', { name: 'Evidência insuficiente' })).toBeVisible()
    await expect
      .element(page.getByText('O enriquecimento ainda pode alterar este veredito.', { exact: true }))
      .toBeVisible()
  })

  it('explica quando o CNPJ não está na competência carregada', async () => {
    render(
      <ValidationResult validation={{ ...validation, address_unavailable_reason: 'cnpj_not_in_snapshot' }} />,
    )

    await expect
      .element(
        page.getByText(
          'Este CNPJ não está na competência carregada da Receita. As verificações que dependem do cadastro ficam sem dados até a próxima carga.',
          { exact: true },
        ),
      )
      .toBeVisible()
  })
})
