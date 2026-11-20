import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { HolderAccessView } from '../api/holder-access'
import { HolderAccessPage } from './HolderAccess'

/**
 * Interface pública do Holder (F4.1).
 *
 * Regras verificadas aqui: o token vive apenas em memória, todas as chamadas
 * vão para `/v1/holder-access` (nada para terceiros), o aceite usa a versão
 * dos termos do servidor, upload só é liberado após consentimento e estados
 * expirada/cancelada bloqueiam envio.
 */

const TOKEN = 'hlt_TEST_TOKEN_0001'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

type Call = {
  readonly method: string
  readonly url: string
  readonly body: BodyInit | null
}

const baseView = (overrides: Partial<HolderAccessView> = {}): HolderAccessView => ({
  requestId: REQUEST_ID,
  type: 'documento_complementar',
  purpose: 'Comprovação de residência',
  state: 'pending',
  status: 'aguardando_consentimento',
  consent: { granted: false, termsVersion: null, acceptedAt: null },
  terms: { version: '1.0.0', approved: true, documentHash: 'sha256:abc123def456' },
  expiresAt: '2026-12-01T12:00:00.000Z',
  completedAt: null,
  items: [
    {
      itemId: 'address-proof',
      description: 'Comprovante de residência',
      required: true,
      documentType: 'proof_of_address',
      value: null,
      documents: [],
    },
  ],
  ...overrides,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const installMock = (initial: HolderAccessView) => {
  const state = { view: initial, calls: [] as Call[] }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init.method ?? 'GET').toUpperCase()
      state.calls.push({
        method,
        url: `${url.pathname}${url.search}`,
        body: init.body ?? null,
      })

      if (url.pathname === '/v1/holder-access' && method === 'GET') {
        return json(state.view)
      }

      if (url.pathname === '/v1/holder-access/consent' && method === 'POST') {
        state.view = {
          ...state.view,
          status: 'aguardando_documentos',
          consent: {
            granted: true,
            termsVersion: '1.0.0',
            acceptedAt: '2026-11-20T10:00:00.000Z',
          },
        }
        return json(state.view.consent)
      }

      if (url.pathname === '/v1/holder-access/items/address-proof/documents' && method === 'POST') {
        state.view = {
          ...state.view,
          items: state.view.items.map((item) => ({
            ...item,
            documents: [
              {
                documentId: '22222222-2222-4222-8222-222222222222',
                contentType: 'image/png',
                sizeBytes: 8,
                originalFilename: 'comprovante.png',
                createdAt: '2026-11-20T10:05:00.000Z',
              },
            ],
          })),
        }
        return json(state.view)
      }

      if (url.pathname.endsWith('/processing')) {
        return json({ title: 'Processamento ainda não iniciado' }, 404)
      }

      return json({ title: 'Não encontrado' }, 404)
    }),
  )

  return state
}

const renderPage = async (token: string | null = TOKEN) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <HolderAccessPage token={token} />
    </QueryClientProvider>,
  )
  return screen
}

const selectFile = async (container: HTMLElement, file: File): Promise<void> => {
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('input de arquivo não encontrado')
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(file)
  input.files = dataTransfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('HolderAccessPage', () => {
  it('apresenta a versão dos termos do servidor e exige aceite explícito', async () => {
    const state = installMock(baseView())
    const screen = await renderPage()

    await expect
      .element(page.getByText('Li e aceito a versão 1.0.0 dos termos aplicáveis a esta solicitação.'))
      .toBeVisible()
    await expect.element(page.getByText('sha256:abc123def456')).toBeVisible()

    const fileInput = screen.container.querySelector('input[type="file"]')
    expect(fileInput).toBeInstanceOf(HTMLInputElement)
    expect((fileInput as HTMLInputElement).disabled).toBe(true)

    const accept = page.getByRole('button', { name: 'Aceitar e continuar' })
    expect(accept.element()).toBeDisabled()
    await userEvent.click(page.getByRole('checkbox'))
    await userEvent.click(accept)

    await expect.element(page.getByText(/Consentimento registrado/)).toBeVisible()

    const consentCall = state.calls.find(
      (call) => call.method === 'POST' && call.url === '/v1/holder-access/consent',
    )
    expect(consentCall).toBeDefined()
    expect(JSON.parse(String(consentCall!.body))).toEqual({ termsVersion: '1.0.0' })

    // Toda a comunicação é com a própria API pública; nada para terceiros.
    expect(state.calls.every((call) => call.url.startsWith('/v1/holder-access'))).toBe(true)
    // O token nunca é persistido em storage.
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('bloqueia o aceite quando o conteúdo jurídico não está aprovado', async () => {
    installMock(baseView({ terms: { version: '1.0.0', approved: false, documentHash: 'sha256:abc' } }))
    await renderPage()

    await expect
      .element(page.getByText(/O conteúdo jurídico dos termos ainda não foi aprovado/))
      .toBeVisible()
    expect(page.getByRole('checkbox').elements()).toHaveLength(0)
    expect(page.getByRole('button', { name: 'Aceitar e continuar' }).elements()).toHaveLength(0)
  })

  it('link inválido mostra mensagem segura, sem ecoar o token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ title: 'Token de acesso inválido', code: 'HOLDER_ACCESS_UNAUTHORIZED', status: 401 }, 401),
      ),
    )
    await renderPage()

    await expect
      .element(
        page.getByText('Este link é inválido, expirou ou foi revogado. Solicite um novo link ao Verifier.'),
      )
      .toBeVisible()
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('solicitação cancelada não permite novo envio', async () => {
    installMock(
      baseView({
        state: 'cancelled',
        status: 'encerrada',
        consent: {
          granted: true,
          termsVersion: '1.0.0',
          acceptedAt: '2026-11-20T10:00:00.000Z',
        },
      }),
    )
    await renderPage()

    await expect
      .element(page.getByRole('status').getByText('Esta solicitação foi cancelada pelo Verifier.'))
      .toBeVisible()
    expect(page.getByRole('button', { name: /Enviar solicitação/ }).elements()).toHaveLength(0)
  })

  it('solicitação expirada informa o prazo e bloqueia envio', async () => {
    installMock(
      baseView({
        state: 'expired',
        status: 'expirada',
        consent: {
          granted: true,
          termsVersion: '1.0.0',
          acceptedAt: '2026-11-20T10:00:00.000Z',
        },
      }),
    )
    await renderPage()

    await expect.element(page.getByText(/Esta solicitação expirou em/)).toBeVisible()
    expect(page.getByRole('button', { name: /Enviar solicitação/ }).elements()).toHaveLength(0)
  })

  it('upload após consentimento envia o arquivo e atualiza a lista', async () => {
    const state = installMock(
      baseView({
        status: 'aguardando_documentos',
        consent: {
          granted: true,
          termsVersion: '1.0.0',
          acceptedAt: '2026-11-20T10:00:00.000Z',
        },
      }),
    )
    const screen = await renderPage()

    await expect.element(page.getByRole('button', { name: 'Enviar' })).toBeVisible()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'comprovante.png', {
      type: 'image/png',
    })
    await selectFile(screen.container, file)
    await userEvent.click(page.getByRole('button', { name: 'Enviar' }))

    await expect.element(page.getByText('Documento enviado com sucesso.')).toBeVisible()
    await expect.element(page.getByText(/comprovante\.png/)).toBeVisible()

    const upload = state.calls.find((call) => call.method === 'POST' && call.url.endsWith('/documents'))
    expect(upload).toBeDefined()
    expect(upload!.body).toBeInstanceOf(FormData)
    const uploaded = (upload!.body as FormData).get('file')
    expect(uploaded).toBeInstanceOf(File)
    expect((uploaded as File).name).toBe('comprovante.png')
  })
})
