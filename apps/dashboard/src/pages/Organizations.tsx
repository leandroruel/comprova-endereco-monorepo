'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  useTable,
  tableFeatures,
  coreFeatures,
  rowSortingFeature,
  rowPaginationFeature,
  createSortedRowModel,
  createPaginatedRowModel,
  type ColumnDef,
  type PaginationState,
  type SortingState,
} from '@tanstack/react-table'
import { getOrganizations, type OrganizationDto } from '@/api/client'
import { DashboardLayout } from '@/components/layout'
import {
  BUIBadge,
  BUIButton,
  BUIInput,
  BUIPagination,
  BUITable,
  BUITableBody,
  BUITableCell,
  BUITableColumn,
  BUITableHeader,
  BUITableRow,
  Card,
  CardContent,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { Search, Building2, Users, Clock, CircleAlert, FileText } from 'lucide-react'

const STATUS_LABELS: Record<string, string> = {
  active: 'Ativo',
  pending: 'Pendente',
  inactive: 'Inativo',
  suspended: 'Suspenso',
  onboarding: 'Onboarding',
}

const STATUS_CLASS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  pending: 'bg-amber-100 text-amber-800 border-amber-200',
  inactive: 'bg-muted text-muted-foreground border-muted',
  suspended: 'bg-red-100 text-red-800 border-red-200',
  onboarding: 'bg-blue-100 text-blue-800 border-blue-200',
}

const PAGE_SIZE = 10

const features = tableFeatures({
  ...coreFeatures,
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
})

type OrganizationColumnId = 'tenantId' | 'name' | 'document' | 'createdAt' | 'status' | 'actions'

interface OrganizationColumn {
  readonly id: OrganizationColumnId
  readonly label: string
  readonly sortable: boolean
  /** Coluna que identifica a linha para leitores de tela (React Aria exige
   *  pelo menos uma coluna com `isRowHeader`). */
  readonly isRowHeader?: boolean
  /** Markup da célula. A tabela do Board UI é uma coleção do React Aria, então
   *  o conteúdo é renderizado aqui — não pelo `flexRender` do TanStack. */
  readonly render: (organization: OrganizationDto) => ReactNode
}

/**
 * Definições de coluna no escopo do módulo, e não dentro do componente.
 *
 * `useMemo` é um hook e não pode ser chamado durante a avaliação do módulo —
 * era exatamente isso que disparava "Invalid hook call" ao abrir a página.
 * O TanStack Table também exige referências estáveis para `features` e
 * `columns` entre renders, então uma constante de módulo é o lugar correto.
 */
const COLUMNS: readonly OrganizationColumn[] = [
  {
    id: 'tenantId',
    label: 'ID',
    sortable: true,
    render: (organization) => (
      <span className="font-mono text-xs text-muted-foreground">{organization.tenantId.slice(0, 8)}…</span>
    ),
  },
  {
    id: 'name',
    label: 'Nome',
    sortable: true,
    isRowHeader: true,
    render: (organization) => <span className="text-xs text-muted-foreground">{organization.name}</span>,
  },
  {
    id: 'document',
    label: 'Documento',
    sortable: true,
    render: (organization) =>
      organization.document ? (
        <span className="font-mono text-xs text-muted-foreground">{organization.document}</span>
      ) : (
        <span className="text-xs text-muted-foreground/50">—</span>
      ),
  },
  {
    id: 'createdAt',
    label: 'Criado em',
    sortable: true,
    render: (organization) => (
      <span className="text-xs text-muted-foreground">
        {new Date(organization.createdAt).toLocaleDateString('pt-BR')}
      </span>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    sortable: true,
    render: (organization) => (
      <BUIBadge color="neutral" className={STATUS_CLASS[organization.status] ?? ''}>
        {STATUS_LABELS[organization.status] ?? organization.status}
      </BUIBadge>
    ),
  },
  {
    id: 'actions',
    label: 'Ações',
    sortable: false,
    render: (organization) => (
      <div className="flex items-center gap-2">
        <BUIButton
          variant="ghost"
          size="xs"
          onClick={() => {
            alert(
              `Organização: ${organization.name}\nID: ${organization.tenantId}\nStatus: ${organization.status}`,
            )
          }}
        >
          Ver
        </BUIButton>
      </div>
    ),
  },
]

/**
 * Colunas do TanStack Table: usadas apenas para ordenação e paginação.
 * O markup das células vem de `COLUMNS[].render`.
 */
const columnDefs: ColumnDef<typeof features, OrganizationDto>[] = COLUMNS.map((column) => ({
  id: column.id,
  accessorFn: (organization) => String(organization[column.id as keyof OrganizationDto] ?? ''),
  header: column.label,
  enableSorting: column.sortable,
}))

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly value: string
  readonly accent?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              accent ?? 'bg-muted',
            )}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="font-mono text-2xl font-bold tabular-nums leading-tight text-foreground">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function OrganizationsPage() {
  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  })
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }])

  const {
    data: organizations = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['organizations'],
    queryFn: getOrganizations,
    staleTime: 30_000,
  })

  const filtered = useMemo(
    () =>
      organizations.filter(
        (organization) =>
          organization.name.toLowerCase().includes(search.toLowerCase()) ||
          (organization.document ?? '').toLowerCase().includes(search.toLowerCase()) ||
          organization.tenantId.toLowerCase().includes(search.toLowerCase()),
      ),
    [organizations, search],
  )

  const table = useTable({
    features,
    columns: columnDefs,
    data: filtered,
    // Estado controlado: sem escrever `state` de volta, os callbacks sozinhos
    // deixam a tabela dessincronizada da UI (paginação e ordenação).
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
  })

  const total = organizations.length
  const activeCount = organizations.filter((organization) => organization.status === 'active').length
  const pendingCount = organizations.filter((organization) => organization.status === 'pending').length
  const suspendedCount = organizations.filter((organization) => organization.status === 'suspended').length

  const pageRows = table.getRowModel().rows.map((row) => row.original)
  const totalPages = table.getPageCount()

  const handleCreate = useCallback(() => {
    alert('Cadastro de organização em breve')
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
    // Busca nova sempre volta para a primeira página.
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  return (
    <DashboardLayout activePage="organizations">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Organizações</h1>
            <p className="text-sm text-muted-foreground">Gerencie as organizações do sistema</p>
          </div>

          <div className="flex w-full items-center gap-2 lg:w-auto">
            <div className="relative flex-1 lg:w-64">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <BUIInput
                placeholder="Buscar organização…"
                value={search}
                onChange={handleSearchChange}
                className="pl-9"
              />
            </div>
            <BUIButton onClick={handleCreate}>
              <Building2 className="mr-2 h-4 w-4" />
              Nova organização
            </BUIButton>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          <StatCard
            icon={<Users className="h-4 w-4 text-foreground/60" />}
            label="Total"
            value={String(total)}
            accent="bg-muted"
          />
          <StatCard
            icon={<Clock className="h-4 w-4 text-emerald-600" />}
            label="Ativas"
            value={String(activeCount)}
            accent="bg-emerald-50"
          />
          <StatCard
            icon={<CircleAlert className="h-4 w-4 text-amber-600" />}
            label="Pendentes"
            value={String(pendingCount)}
            accent="bg-amber-50"
          />
          <StatCard
            icon={<FileText className="h-4 w-4 text-red-600" />}
            label="Suspensas"
            value={String(suspendedCount)}
            accent="bg-red-50"
          />
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-auto">
            <BUITable aria-label="Organizações" size="md">
              <BUITableHeader columns={COLUMNS} dependencies={[sorting]}>
                {(column) => {
                  const sortDirection = table.getColumn(column.id)?.getIsSorted()

                  return (
                    <BUITableColumn
                      key={column.id}
                      id={column.id}
                      isRowHeader={column.isRowHeader}
                      className="font-medium select-none"
                    >
                      {column.sortable ? (
                        <button
                          type="button"
                          onClick={() => table.getColumn(column.id)?.toggleSorting()}
                          className="flex w-full cursor-pointer items-center gap-1 text-left"
                          aria-label={`Ordenar por ${column.label}`}
                        >
                          {column.label}
                          {sortDirection === 'desc' ? ' ▼' : sortDirection === 'asc' ? ' ▲' : ''}
                        </button>
                      ) : (
                        column.label
                      )}
                    </BUITableColumn>
                  )
                }}
              </BUITableHeader>
              <BUITableBody
                items={pageRows}
                renderEmptyState={() =>
                  isLoading ? 'Carregando organizações…' : 'Nenhuma organização encontrada'
                }
              >
                {(organization) => (
                  <BUITableRow key={organization.tenantId} id={organization.tenantId}>
                    {COLUMNS.map((column) => (
                      <BUITableCell key={column.id}>{column.render(organization)}</BUITableCell>
                    ))}
                  </BUITableRow>
                )}
              </BUITableBody>
            </BUITable>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Exibindo {pagination.pageIndex * PAGE_SIZE + 1}
              {'-'}
              {Math.min((pagination.pageIndex + 1) * PAGE_SIZE, filtered.length)} de {filtered.length}{' '}
              resultados
            </p>
            <BUIPagination
              page={pagination.pageIndex + 1}
              totalPages={totalPages}
              onChange={(pageNumber: number) => table.setPageIndex(pageNumber - 1)}
              previousLabel="Anterior"
              nextLabel="Próximo"
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Erro ao carregar organizações'}
          </p>
        )}
      </div>
    </DashboardLayout>
  )
}
