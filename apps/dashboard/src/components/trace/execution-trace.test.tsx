import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import type { DebugTraceEventDto } from '@/api/client'
import { ExecutionTrace } from './ExecutionTrace'

const events: readonly DebugTraceEventDto[] = [
  {
    code: 'pdf.open',
    level: 'success',
    message: 'PDF aberto (1 página).',
    details: { pages: 1, encrypted: false },
  },
  {
    code: 'pdf.text',
    level: 'info',
    message: 'Camada textual extraída (120 caracteres).',
    details: { chars: 120 },
  },
  {
    code: 'pdf.image.qr',
    level: 'warning',
    message: 'Nenhum QR legível na imagem.',
    details: { page: 1, images: 2, probes: [{ result: 'no_symbol' }] },
  },
  {
    code: 'pdf.reference',
    level: 'error',
    message: 'Falha ao ler o QR.',
    details: { reason: 'decode_failed' },
  },
]

const tabs = () => page.getByRole('tab')

describe('ExecutionTrace', () => {
  it('mostra resumo, tempo total e o primeiro passo selecionado', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={events} elapsedMs={1840} />)

    const summary = page.getByTestId('trace-summary')
    await expect.element(summary).toMatchTextContent(/4 passos/)
    await expect.element(summary).toMatchTextContent(/1 sucesso/)
    await expect.element(summary).toMatchTextContent(/1 info/)
    await expect.element(summary).toMatchTextContent(/1 alerta/)
    await expect.element(summary).toMatchTextContent(/1 erro/)
    await expect.element(summary).toMatchTextContent(/1,8 s/)

    const detail = page.getByTestId('trace-detail')
    await expect.element(detail.getByText('Passo 1 de 4')).toBeVisible()
    await expect.element(detail.getByText('PDF aberto (1 página).')).toBeVisible()
    await expect.element(detail.getByRole('heading', { name: 'pdf.open' })).toBeVisible()
    await expect.element(detail.getByText('pages', { exact: true })).toBeVisible()
  })

  it('troca o passo selecionado ao clicar na timeline', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={events} />)

    await tabs().nth(2).click()

    await expect.element(tabs().nth(2)).toHaveAttribute('aria-selected', 'true')
    await expect.element(tabs().nth(0)).toHaveAttribute('aria-selected', 'false')
    await expect.element(page.getByTestId('trace-detail').getByText('Passo 3 de 4')).toBeVisible()
    await expect.element(page.getByText('Nenhum QR legível na imagem.').first()).toBeVisible()
  })

  it('navega com o teclado (setas e j/k)', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={events} />)

    await tabs().nth(0).click()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(tabs().nth(1)).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('j')
    await expect.element(tabs().nth(2)).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('k')
    await expect.element(tabs().nth(1)).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}')
    await expect.element(tabs().nth(0)).toHaveAttribute('aria-selected', 'true')
  })

  it('filtra por status e mostra contagem e vazio', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={events} />)

    await page.getByRole('button', { name: /^Erro/ }).click()

    await expect.element(page.getByText('1 de 4')).toBeVisible()
    await expect.element(page.getByTestId('trace-detail').getByText('Falha ao ler o QR.')).toBeVisible()
    expect(tabs().elements()).toHaveLength(1)

    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await expect.element(page.getByText('4 de 4')).toBeVisible()
    expect(tabs().elements()).toHaveLength(4)
  })

  it('busca também dentro do JSON dos detalhes', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={events} />)

    await page.getByRole('searchbox', { name: 'Buscar no trace' }).fill('decode_failed')

    await expect.element(page.getByText('1 de 4')).toBeVisible()
    expect(tabs().elements()).toHaveLength(1)

    await page.getByRole('searchbox', { name: 'Buscar no trace' }).fill('inexistente')
    await expect.element(page.getByText('Nenhum passo corresponde aos filtros')).toBeVisible()
    await page.getByRole('button', { name: 'Limpar filtros' }).last().click()
    await expect.element(page.getByText('4 de 4')).toBeVisible()
  })

  it('mantém o layout empilhado no mobile com o detalhe do passo selecionado', async () => {
    await page.viewport(420, 900)
    await render(<ExecutionTrace events={events} />)

    await tabs().nth(1).click()

    const mobileDetail = page.getByTestId('trace-detail-mobile')
    await expect.element(mobileDetail.getByText('Camada textual extraída (120 caracteres).')).toBeVisible()
  })

  it('expande e recolhe todas as seções do JSON do passo selecionado', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={events} />)

    await tabs().nth(2).click()
    const detail = page.getByTestId('trace-detail')

    await expect.element(detail.getByText('probes', { exact: true })).toBeVisible()
    await expect.element(detail.getByText('result', { exact: true })).not.toBeInTheDocument()

    await page.getByRole('button', { name: /^Expandir tudo/ }).click()
    await expect.element(detail.getByText('result', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: /^Recolher tudo/ }).click()
    await expect.element(detail.getByText('result', { exact: true })).not.toBeInTheDocument()
  })

  it('mostra estado vazio sem eventos', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={[]} />)

    await expect.element(page.getByText('Nenhum evento registrado')).toBeVisible()
    await expect.element(page.getByText('Trace de execução')).toBeVisible()
  })

  it('mostra skeleton durante o loading', async () => {
    await page.viewport(1280, 900)
    await render(<ExecutionTrace events={[]} loading />)

    await expect.element(page.getByLabelText('Carregando trace de execução')).toBeVisible()
  })
})
