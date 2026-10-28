import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type {
  AddressInput,
  CepAddressLookup,
  ValidationDto,
  ValidationProgressDto,
  ValidationProgressStage,
  ValidationProgressStepStatus,
} from '@/api/client'
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

const STAGES: readonly ValidationProgressStage[] = [
  'reading_document',
  'reading_qr',
  'consulting_provider',
  'verifying_authenticity',
  'comparing_evidence',
]

const progress = (
  status: ValidationProgressDto['status'],
  statuses: Partial<Record<ValidationProgressStage, ValidationProgressStepStatus>> = {},
): ValidationProgressDto => ({
  status,
  steps: STAGES.map((stage) => ({ stage, status: statuses[stage] ?? 'pending' })),
})

const progressAt = (index: number): ValidationProgressDto => ({
  status: 'in_progress',
  steps: STAGES.map((stage, position) => ({
    stage,
    status: position < index ? 'completed' : position === index ? 'in_progress' : 'pending',
  })),
})

const processing = baseValidation({ status: 'partial', verdict: null, score: null })

const done = baseValidation({
  status: 'completed',
  fiscal_reference: 'found',
  fiscal_reassessment: 'completed',
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
  progress: progress('failed', {
    reading_document: 'completed',
    reading_qr: 'completed',
    consulting_provider: 'failed',
    verifying_authenticity: 'skipped',
    comparing_evidence: 'skipped',
  }),
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
  await page.getByPlaceholder(/CPF ou CNPJ do endereço/).fill(document)
  setFile()
  await page.getByRole('button', { name: 'Iniciar validação' }).click()
}

const fillAddress = async (): Promise<void> => {
  await page.getByPlaceholder('Logradouro').fill('Rua das Flores')
  await page.getByPlaceholder('Número').fill('100')
  await page.getByPlaceholder('Bairro (opcional)').fill('Centro')
  await page.getByPlaceholder('Município').fill('São Paulo')
  await page.getByPlaceholder('UF').fill('SP')
  await page.getByPlaceholder('CEP').fill('01310-100')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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

    // Estado inicial real: o upload foi aceito e a primeira leitura do worker
    // ainda está por vir. Não há animação fictícia de etapas.
    await expect.element(page.getByText('Validação em andamento')).toBeVisible()
    await expect
      .element(page.getByTestId('progress-step-reading_document'))
      .toHaveAttribute('data-status', 'in_progress')

    // A 1ª leitura ainda não tem evidências: continua processando.
    releaseFirstPoll(processing)
    await expect
      .element(page.getByTestId('progress-step-reading_qr'))
      .toHaveAttribute('data-status', 'pending')

    // Conclui com o verdict e as evidências (taxonomia preservada:
    // indisponibilidade fiscal ≠ endereço falso). O progresso mínimo continua
    // visível para mostrar qual etapa não pôde ser concluída.
    await expect.element(page.getByText('Comercial confirmado')).toBeVisible()
    await expect.element(page.getByText('Comprovante e consulta fiscal')).toBeVisible()
    await expect
      .element(page.getByText('a consulta fiscal não pôde ser concluída — autorizador indisponível'))
      .toBeVisible()
    await expect.element(page.getByText('Uma etapa não pôde ser concluída')).toBeVisible()
    await expect.element(page.getByText('Não foi possível consultar o provedor fiscal.')).toBeVisible()
  })

  it('envia o endereço informado quando o documento é um CPF', async () => {
    const createSpy = vi.fn(async () => processing)
    await wrap(
      <E2eRunner
        deps={{
          create: createSpy,
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => done),
          pollIntervalMs: 50,
        }}
      />,
    )

    await page.getByPlaceholder(/CPF ou CNPJ do endereço/).fill('529.982.247-25')
    await fillAddress()
    setFile()
    await page.getByRole('button', { name: 'Iniciar validação' }).click()

    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1))
    const [document, address] = createSpy.mock.calls[0] as unknown as [
      string,
      AddressInput | null | undefined,
    ]
    expect(document).toBe('529.982.247-25')
    expect(address).toMatchObject({
      logradouro: 'Rua das Flores',
      numero: '100',
      bairro: 'Centro',
      municipio: 'São Paulo',
      uf: 'SP',
      cep: '01310-100',
    })
  })

  it('preenche o endereço ao digitar um CEP válido', async () => {
    const lookupCep = vi.fn(async (_cep: string): Promise<CepAddressLookup> => ({
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      municipio: 'São Paulo',
      uf: 'SP',
    }))
    const createSpy = vi.fn(async () => processing)

    await wrap(
      <E2eRunner
        deps={{
          create: createSpy,
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => done),
          lookupCep,
          pollIntervalMs: 50,
        }}
      />,
    )

    await page.getByPlaceholder(/CPF ou CNPJ do endereço/).fill('529.982.247-25')
    await page.getByPlaceholder('CEP').fill('01310100')

    await vi.waitFor(() => expect(lookupCep).toHaveBeenCalledWith('01310100', expect.anything()))
    await expect.element(page.getByPlaceholder('Logradouro')).toHaveValue('Avenida Paulista')
    await expect.element(page.getByPlaceholder('Bairro (opcional)')).toHaveValue('Bela Vista')
    await expect.element(page.getByPlaceholder('Município')).toHaveValue('São Paulo')
    await expect.element(page.getByPlaceholder('UF')).toHaveValue('SP')
  })

  it('preenche o logradouro usando a busca padrão da BrasilAPI', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            street: 'Avenida Paulista',
            neighborhood: 'Bela Vista',
            city: 'São Paulo',
            state: 'SP',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => processing),
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => done),
          pollIntervalMs: 50,
        }}
      />,
    )

    await page.getByPlaceholder(/CPF ou CNPJ do endereço/).fill('529.982.247-25')
    await page.getByPlaceholder('CEP').fill('01310100')

    await vi.waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://brasilapi.com.br/api/cep/v2/01310100',
        expect.objectContaining({ signal: expect.anything() }),
      ),
    )
    await expect.element(page.getByPlaceholder('Logradouro')).toHaveValue('Avenida Paulista')
  })

  it('bloqueia o envio quando o CPF não tem endereço completo', async () => {
    const createSpy = vi.fn(async () => processing)
    await wrap(
      <E2eRunner
        deps={{
          create: createSpy,
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => done),
          pollIntervalMs: 50,
        }}
      />,
    )

    await page.getByPlaceholder(/CPF ou CNPJ do endereço/).fill('529.982.247-25')
    setFile()

    await expect.element(page.getByText(/Preencha: Logradouro, Número, Município, UF, CEP/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Iniciar validação' })).toBeDisabled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('não exibe campos de endereço quando o documento é um CNPJ', async () => {
    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => processing),
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => done),
          pollIntervalMs: 50,
        }}
      />,
    )

    await page.getByPlaceholder(/CPF ou CNPJ do endereço/).fill('12.345.678/0001-95')
    await expect.element(page.getByPlaceholder('Logradouro')).not.toBeInTheDocument()
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

  it('não encerra o acompanhamento enquanto a reavaliação fiscal está pendente', async () => {
    // O tick fiscal materializa a evidência ANTES de reavaliar: o GET já mostra
    // `fiscal_verification` com o veredito ANTERIOR e `fiscal_reassessment =
    // pending`. Duas leituras idênticas nesse estado não podem encerrar o watch.
    const pending = baseValidation({
      status: 'partial',
      verdict: null,
      score: null,
      fiscal_reference: 'found',
      fiscal_reassessment: 'pending',
      evidence_verification: {
        status: 'completed',
        method: 'content_extraction',
        source: {
          kind: 'customer_submitted_document',
          id: 'intake',
          authority: null,
          environment: 'local',
        },
        document: 'authentic',
        address: 'not_extracted',
        holder: 'not_extracted',
        analysis_id: 'a1b2c3d4-0000-4000-8000-000000000003',
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
        status: 'completed',
        method: 'official_qr_consultation',
        source: { kind: 'fiscal_nf3e', id: 'nf3e', authority: 'SVRS', environment: 'production' },
        document: 'authentic',
        address: 'not_extracted',
        holder: 'not_extracted',
        adapter_version: '1.0.0',
        contract_version: '2',
        observed_at: NOW,
        limitations: [],
        error_codes: [],
      },
      progress: progress('in_progress', {
        reading_document: 'completed',
        reading_qr: 'completed',
        consulting_provider: 'completed',
        verifying_authenticity: 'completed',
        comparing_evidence: 'in_progress',
      }),
    })

    const queue: ValidationDto[] = [processing, pending, pending, done, done]
    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => processing),
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => queue.shift() ?? done),
          pollIntervalMs: 50,
        }}
      />,
    )

    await submit('12.345.678/0001-95')

    // O estado de reavaliação pendente é comunicado com a etapa real em
    // andamento (a comparação ainda não terminou)…
    await expect
      .element(page.getByTestId('progress-step-comparing_evidence'))
      .toHaveAttribute('data-status', 'in_progress')
    await expect.element(page.getByText('Comparando evidências')).toBeVisible()

    // …e o watch sobrevive às leituras inalteradas até o assessment novo
    // chegar: o resultado final é o veredito pós-reavaliação, não o anterior.
    await expect.element(page.getByText('Comercial confirmado')).toBeVisible()
    await expect.element(page.getByText('Consulta fiscal NF3e', { exact: true })).toBeVisible()
  })

  it('conclui comprovante sem QR sem esperar uma consulta fiscal que não vai acontecer', async () => {
    const noQr = baseValidation({
      status: 'completed',
      fiscal_reference: 'not_found',
      evidence_verification: {
        status: 'completed',
        method: 'content_extraction',
        source: {
          kind: 'customer_submitted_document',
          id: 'intake',
          authority: null,
          environment: 'local',
        },
        document: 'authentic',
        address: 'not_extracted',
        holder: 'not_extracted',
        analysis_id: 'a1b2c3d4-0000-4000-8000-000000000004',
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
      progress: progress('completed', {
        reading_document: 'completed',
        reading_qr: 'completed',
        consulting_provider: 'skipped',
        verifying_authenticity: 'skipped',
        comparing_evidence: 'skipped',
      }),
    })

    const queue: ValidationDto[] = [processing, noQr, noQr]
    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => processing),
          upload: vi.fn(async () => undefined),
          poll: vi.fn(async () => queue.shift() ?? noQr),
          pollIntervalMs: 50,
        }}
      />,
    )

    await submit('12.345.678/0001-95')

    // Sem QR não há consulta esperada: conclui normalmente com o comprovante
    // e sem a seção fiscal.
    await expect.element(page.getByText('Comercial confirmado')).toBeVisible()
    await expect.element(page.getByText('Comprovante enviado', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Consulta fiscal NF3e', { exact: true })).not.toBeInTheDocument()
  })

  it('atualiza o progresso pelo polling existente até concluir e então mostra o resultado', async () => {
    const evidence = done.evidence_verification
    if (evidence == null) throw new Error('fixture de verificação ausente')
    const fiscalAuthentic = {
      status: 'completed' as const,
      method: 'official_qr_consultation',
      source: {
        kind: 'fiscal_nf3e',
        id: 'nf3e',
        authority: 'SVRS',
        environment: 'production' as const,
      },
      document: 'authentic' as const,
      address: 'not_extracted' as const,
      holder: 'not_extracted' as const,
      adapter_version: '1.0.0',
      contract_version: '2',
      observed_at: NOW,
      limitations: [],
      error_codes: [],
    }

    const afterUpload = baseValidation({
      status: 'partial',
      verdict: null,
      score: null,
      progress: progressAt(0),
    })
    const readingQr = baseValidation({
      status: 'partial',
      verdict: null,
      score: null,
      fiscal_reference: 'found',
      evidence_verification: evidence,
      progress: progress('in_progress', {
        reading_document: 'completed',
        reading_qr: 'in_progress',
        consulting_provider: 'pending',
        verifying_authenticity: 'pending',
        comparing_evidence: 'pending',
      }),
    })
    const consulting = baseValidation({
      status: 'partial',
      verdict: null,
      score: null,
      fiscal_reference: 'found',
      fiscal_reassessment: 'pending',
      evidence_verification: evidence,
      progress: progress('in_progress', {
        reading_document: 'completed',
        reading_qr: 'completed',
        consulting_provider: 'in_progress',
        verifying_authenticity: 'pending',
        comparing_evidence: 'pending',
      }),
    })
    const comparing = baseValidation({
      status: 'partial',
      verdict: null,
      score: null,
      fiscal_reference: 'found',
      fiscal_reassessment: 'pending',
      evidence_verification: evidence,
      fiscal_verification: fiscalAuthentic,
      progress: progress('in_progress', {
        reading_document: 'completed',
        reading_qr: 'completed',
        consulting_provider: 'completed',
        verifying_authenticity: 'completed',
        comparing_evidence: 'in_progress',
      }),
    })
    const completed = baseValidation({
      status: 'completed',
      fiscal_reference: 'found',
      fiscal_reassessment: 'completed',
      evidence_verification: evidence,
      fiscal_verification: fiscalAuthentic,
      progress: progress('completed', {
        reading_document: 'completed',
        reading_qr: 'completed',
        consulting_provider: 'completed',
        verifying_authenticity: 'completed',
        comparing_evidence: 'completed',
      }),
    })

    const resolvers: Array<(value: ValidationDto) => void> = []
    const pollMock = vi.fn(
      () =>
        new Promise<ValidationDto>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const resolveNext = (value: ValidationDto): void => {
      const resolve = resolvers.shift()
      if (resolve === undefined) throw new Error('poll pendente não encontrado')
      resolve(value)
    }
    const waitForPoll = async (): Promise<void> => {
      await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
    }

    await wrap(
      <E2eRunner
        deps={{
          create: vi.fn(async () => processing),
          upload: vi.fn(async () => undefined),
          poll: pollMock,
          pollIntervalMs: 50,
        }}
      />,
    )

    await submit('12.345.678/0001-95')

    await waitForPoll()
    resolveNext(afterUpload)
    await expect
      .element(page.getByTestId('progress-step-reading_document'))
      .toHaveAttribute('data-status', 'in_progress')

    await waitForPoll()
    resolveNext(readingQr)
    await expect
      .element(page.getByTestId('progress-step-reading_qr'))
      .toHaveAttribute('data-status', 'in_progress')

    await waitForPoll()
    resolveNext(consulting)
    await expect
      .element(page.getByTestId('progress-step-consulting_provider'))
      .toHaveAttribute('data-status', 'in_progress')

    await waitForPoll()
    resolveNext(comparing)
    await expect
      .element(page.getByTestId('progress-step-comparing_evidence'))
      .toHaveAttribute('data-status', 'in_progress')

    await waitForPoll()
    resolveNext(completed)
    // O runner pode encerrar já na primeira leitura estável (o callback de
    // intervalo pode ser reavaliado sem uma nova leitura); se ele ainda pedir
    // outro poll, entrega o mesmo estado para a regra de estabilidade fechar.
    try {
      await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0), { timeout: 250 })
      resolveNext(completed)
    } catch {
      // Já encerrado: o resultado final abaixo é a asserção que importa.
    }

    await expect.element(page.getByText('Comercial confirmado')).toBeVisible()
    await expect.element(page.getByText('Validação concluída')).not.toBeInTheDocument()
  })
})
