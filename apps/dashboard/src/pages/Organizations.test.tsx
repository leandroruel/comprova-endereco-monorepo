import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import OrganizationsPage from './Organizations'
import type { OrganizationDto } from '@/api/client'

function makeOrganization(index: number, overrides: Partial<OrganizationDto> = {}): OrganizationDto {
  return {
    tenantId: `1111111${String(index).padStart(2, '0')}-1111-1111-1111-111111111111`,
    name: `Org ${String(index).padStart(2, '0')}`,
    legalName: null,
    document: null,
    type: 'company',
    status: 'active',
    onboardingStatus: 'completed',
    termsAcceptedAt: null,
    termsAcceptedBy: null,
    termsVersion: null,
    termsDocumentHash: null,
    dataRegion: 'br-south',
    rateLimitRps: 10,
    burst: 20,
    monthlyQuota: null,
    // Datas crescentes: a ordenação padrão (createdAt desc) mostra a de maior
    // índice primeiro, o que deixa as asserções de paginação previsíveis.
    createdAt: `2026-01-${String(index).padStart(2, '0')}T12:00:00.000Z`,
    ...overrides,
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationsPage />
    </QueryClientProvider>,
  )
}

function mockOrganizations(organizations: OrganizationDto[]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(organizations), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrganizationsPage', () => {
  it('renderiza a página sem quebrar as regras de hooks', async () => {
    mockOrganizations([
      makeOrganization(1, { name: 'Acme Ltda', document: '12345678000199', status: 'active' }),
      makeOrganization(2, { name: 'Beta SA', status: 'pending' }),
    ])

    await renderPage()

    await expect.element(page.getByRole('heading', { name: 'Organizações' })).toBeVisible()
    await expect.element(page.getByText('Acme Ltda', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Beta SA', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Ativo', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Pendente', { exact: true })).toBeVisible()
  })

  it('filtra pelo termo de busca', async () => {
    mockOrganizations([makeOrganization(1, { name: 'Acme Ltda' }), makeOrganization(2, { name: 'Beta SA' })])

    await renderPage()
    await expect.element(page.getByText('Acme Ltda', { exact: true })).toBeVisible()

    await page.getByPlaceholder('Buscar organização…').fill('Beta')

    await expect.element(page.getByText('Beta SA', { exact: true })).toBeVisible()
    await expect(page.getByText('Acme Ltda', { exact: true })).not.toBeInTheDocument()
  })

  it('pagina os resultados de acordo com o estado controlado da tabela', async () => {
    mockOrganizations(Array.from({ length: 12 }, (_, index) => makeOrganization(index + 1)))

    await renderPage()

    await expect.element(page.getByText('Exibindo 1-10 de 12 resultados')).toBeVisible()
    await expect.element(page.getByText('Org 03', { exact: true })).toBeVisible()
    // A 11ª mais recente fica na segunda página.
    await expect(page.getByText('Org 01', { exact: true })).not.toBeInTheDocument()

    await page.getByRole('button', { name: 'Próximo' }).click()

    await expect.element(page.getByText('Exibindo 11-12 de 12 resultados')).toBeVisible()
    await expect.element(page.getByText('Org 01', { exact: true })).toBeVisible()
  })
})
