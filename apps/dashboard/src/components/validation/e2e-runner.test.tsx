import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { ValidationDto } from '@/api/client'
import { E2eRunner } from './e2e-runner'

/**
 * Vertical slice — o fluxo do dashboard com o backend falso:
 * submissão → upload → processando → concluído com evidências; e erro.
 */

const NOW = '2026-10-26T12:00:00.000Z'
const VALIDATION_ID = 'e2e12345-6789-4abc-9def-000000000001'

const baseValidation = (overrides: Partial<ValidationDto> = {}): ValidationDto => ({
  validation_id: VALIDATION_ID,
  status: 'completed',
  verdict: 'CONFIRMED_COMMERCIAL',
  confidence: 0.9,
  score: 0.72,
  policy_version: '2026.14.1',
  address: null,
  signals: [],
  claim: null,
  explanation: 'Endereço compatível.',
  explanation_detail: null,
  created_at: NOW,
  expires_at: '2026-11-25T12:00:00.000Z',
  ...overrides,
})

const processing = baseValidation({ status: 'partial', verdict: null, score: null })

const done = baseValidation({
  status: 'completed',
  evidence_verification: {
    status: 'completed',
    method: 'content_extraction',
    source: { kind: 'customer_submitted_document', id: 'intake', authority: null, environment: 'local' },
    document: 'authentic',
    address: 'not_extracted',
    holder: 'not_extracted',
    analysis_id: 'a1b2c3d4-0000-4000-8000-000000000001',
    analyzer: { id: 'pdf-text', version: '1.0.0' },
    contract_version: '3',
    observed_at: NOW,
    limitations: [],
    error_codes: [],
    comparison: {
      address: { compared_fields: [], reason_codes: [] },
      holder: { reference: 'none', reason_codes: [] },
    },
  },
  fiscal_verification: {
    status: 'unavailable',
    method: 'official_qr_consultation',
    source: { kind: 'fiscal_nf3e', id: 'nf3e', authority: 'SVRS', environment: 'production' },
    document: 'unavailable',
    address: 'not_extracted',
    holder: 'not_extracted',
    adapter_version: '1.0.0',
    contract_version: '2',
    observed_at: NOW,
    limitations: ['SOURCE_UNAVAILABLE'],
    error_codes: ['SEFAZ_TIMEOUT'],
  },
})

const wrap = (node: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const setFile = (): void => {
  const input = document.querySelector('input[type="file"]')
  if (input === null || !(input instanceof HTMLInputElement)) throw new Error('file input missing')
  const transfer = new DataTransfer()
  transfer.items.add(new File(['%PDF-1.4 fixture'], 'comprovante.pdf', { type: 'application/pdf' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const submit = async (document: string): Promise<void> => {
  await page.getByPlaceholder(/CNPJ do endereço/).fill(document)
  setFile()
  await page.getByRole('button', { name: 'Iniciar validação' }).click()
}

describe('E2eRunner — vertical slice', () => {
  it('executa o fluxo: criar, subir comprovante, processar e concluir com evidências', async () => {
    const uploadCalls: string[] = []
    let releaseFirstPoll!: (value: ValidationDto) => void
    const firstPoll = new Promise<ValidationDto>((resolve) => {
      releaseFirstPoll = resolve
    })
    const pollMock = vi.fn(async (_validationId: string): Promise<ValidationDto> => done)
    pollMock.mockImplementationOnce(() => firstPoll)

    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => processing),
          upload: vi.fn(async (validationId: string) => {
            uploadCalls.push(validationId)
          }),
          poll: pollMock,
          pollIntervalMs: 50,
        }}
      />,
    )

    await submit('12.345.678/0001-95')

    // O upload do comprovante foi orquestrado pelo frontend.
    expect(uploadCalls).toEqual([VALIDATION_ID])

    // Estado de processamento é comunicado enquanto o worker trabalha.
    await expect.element(page.getByText(/Processando — intake, análise e consulta fiscal/)).toBeVisible()

    // A 1ª leitura ainda não tem evidências: continua processando.
    releaseFirstPoll(processing)
    await expect.element(page.getByText(/comprovante ainda não analisado/)).toBeVisible()

    // Conclui com o verdict e as evidências (taxonomia preservada:
    // indisponibilidade fiscal ≠ endereço falso).
    await expect.element(page.getByText('Comercial confirmado')).toBeVisible()
    await expect.element(page.getByText('Comprovante e consulta fiscal')).toBeVisible()
    await expect
      .element(page.getByText('a consulta fiscal não pôde ser concluída — autorizador indisponível'))
      .toBeVisible()
  })

  it('mostra erro de submissão sem quebrar a tela', async () => {
    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => {
            throw new Error('CNPJ fora da competência carregada')
          }),
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => done),
          pollIntervalMs: 50,
        }}
      />,
    )

    await submit('00.000.000/0000-00')

    await expect.element(page.getByRole('alert')).toHaveTextContent('CNPJ fora da competência carregada')
    // O formulário continua na tela para nova tentativa.
    await expect.element(page.getByRole('button', { name: 'Iniciar validação' })).toBeVisible()
  })
})
