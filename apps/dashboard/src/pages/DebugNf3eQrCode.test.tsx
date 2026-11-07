import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { DebugNf3eQrCodeResponse } from '@/api/client'
import { DebugNf3eQrCodePage } from './DebugNf3eQrCode'
import { DashboardLayout } from '@/components/layout'

const pdf = (): File =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'conta.pdf', { type: 'application/pdf' })

const selectFile = async (container: HTMLElement, file: File): Promise<void> => {
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('input de arquivo não encontrado')
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(file)
  input.files = dataTransfer.files
  // React escuta `change` no root para inputs de arquivo.
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const respondWith = (body: unknown): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

const reference: DebugNf3eQrCodeResponse['reference'] = {
  status: 'inconclusive',
  source: null,
  issuer: null,
  uf: null,
  url: null,
  documentId: null,
  method: 'qr_code',
  limitations: ['PDF_QR_VECTOR_UNSUPPORTED'],
  errorCodes: ['PDF_QR_VECTOR_UNSUPPORTED'],
  fingerprint: null,
}

const analysis: NonNullable<DebugNf3eQrCodeResponse['analysis']> = {
  status: 'completed',
  document: {
    status: 'analyzed',
    kind: 'unknown',
    issuedAt: '2026-11-10',
    issuedRaw: '10/11/2026',
  },
  address: {
    status: 'extracted',
    value: {
      logradouro: 'RUA DAS FLORES',
      numero: '123',
      complemento: 'APTO 45',
      bairro: 'CENTRO',
      cidade: 'SAO PAULO',
      uf: 'SP',
      cep: '01001000',
      raw: 'Rua das Flores, 123, Apto 45',
    },
    raw: 'Rua das Flores, 123, Apto 45',
  },
  holder: {
    status: 'extracted',
    value: { name: 'Maria da Silva', raw: 'Titular: Maria da Silva' },
    raw: 'Titular: Maria da Silva',
  },
  limitations: [],
  errorCodes: [],
  analyzedAt: '2026-10-30T00:00:00.000Z',
  provenance: { provider: 'marker', pages: 2, fallback: false },
}

describe('DebugNf3eQrCodePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('não quebra quando o servidor devolve o payload antigo, sem analysis', async () => {
    respondWith({
      events: [
        {
          code: 'pdf.reference',
          level: 'warning',
          message: 'Nenhum QR legível foi encontrado no PDF.',
        },
      ],
      reference,
    })

    const screen = await render(<DebugNf3eQrCodePage />)
    await selectFile(screen.container, pdf())
    await userEvent.click(page.getByRole('button', { name: 'Analisar documento' }))

    await expect.element(page.getByText(/A análise completa não está disponível/)).toBeVisible()
    await expect
      .element(page.getByTestId('trace-header').getByText('Trace de execução', { exact: false }))
      .toBeVisible()
    await expect
      .element(page.getByRole('tab').getByText('Nenhum QR legível foi encontrado no PDF.'))
      .toBeVisible()
    await expect.element(page.getByRole('heading', { name: 'QRCode NF3e debugger' })).toBeVisible()
  })

  it('mostra titular e endereço quando a análise completa está presente', async () => {
    respondWith({ events: [], reference, analysis })

    const screen = await render(<DebugNf3eQrCodePage />)
    await selectFile(screen.container, pdf())
    await userEvent.click(page.getByRole('button', { name: 'Analisar documento' }))

    await expect.element(page.getByText('Maria da Silva')).toBeVisible()
    await expect.element(page.getByText('RUA DAS FLORES')).toBeVisible()
    await expect.element(page.getByText('01001000')).toBeVisible()
    await expect.element(page.getByText('10/11/2026')).toBeVisible()
    // A proveniência (fonte do texto) é exposta no debugger.
    await expect.element(page.getByText(/marker · 2p/)).toBeVisible()
  })

  it('mostra "—" como fonte quando nenhum provedor de texto rodou', async () => {
    respondWith({
      events: [],
      reference,
      analysis: {
        ...analysis,
        status: 'invalid',
        document: { status: 'invalid', kind: 'unknown', issuedAt: null, issuedRaw: null },
        address: { status: 'unknown', value: null, raw: null },
        holder: { status: 'unknown', value: null, raw: null },
        limitations: ['PDF_INVALID'],
        errorCodes: ['PDF_INVALID'],
        provenance: null,
      },
    })

    const screen = await render(<DebugNf3eQrCodePage />)
    await selectFile(screen.container, pdf())
    await userEvent.click(page.getByRole('button', { name: 'Analisar documento' }))

    await expect.element(page.getByText('Fonte do texto')).toBeVisible()
    const invalidSource = page.getByText('Fonte do texto').element().parentElement
    expect(invalidSource?.textContent).toContain('—')
    expect(invalidSource?.textContent).not.toContain('local')
  })

  it('mantém "local" quando a extração local rodou e não achou texto (NO_TEXT_LAYER)', async () => {
    respondWith({
      events: [],
      reference,
      analysis: {
        ...analysis,
        status: 'inconclusive',
        document: { status: 'inconclusive', kind: 'unknown', issuedAt: null, issuedRaw: null },
        address: { status: 'unknown', value: null, raw: null },
        holder: { status: 'unknown', value: null, raw: null },
        limitations: ['NO_TEXT_LAYER'],
        errorCodes: ['NO_TEXT_LAYER'],
        provenance: null,
      },
    })

    const screen = await render(<DebugNf3eQrCodePage />)
    await selectFile(screen.container, pdf())
    await userEvent.click(page.getByRole('button', { name: 'Analisar documento' }))

    await expect.element(page.getByText('Fonte do texto')).toBeVisible()
    const localSource = page.getByText('Fonte do texto').element().parentElement
    expect(localSource?.textContent).toContain('local')
  })

  it('mostra o usuário logado no menu do sidemenu, não o rótulo "Conta"', async () => {
    respondWith({ events: [], reference })

    await render(
      <DashboardLayout onNavigate={() => {}} userName="Leandro Rocha" userEmail="leandro@empresa.com">
        <DebugNf3eQrCodePage user={{ name: 'Leandro Rocha', email: 'leandro@empresa.com' }} />
      </DashboardLayout>,
    )

    const trigger = page.getByRole('button', { name: 'Menu do usuário' })
    await expect.element(trigger.getByText('Leandro Rocha', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('leandro@empresa.com', { exact: true })).toBeVisible()
    await expect(trigger.getByText('Conta', { exact: true })).not.toBeInTheDocument()
  })
})
