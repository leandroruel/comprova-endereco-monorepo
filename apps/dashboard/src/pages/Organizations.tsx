'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  useTable,
  flexRender,
  tableFeatures,
  coreFeatures,
  rowSortingFeature,
  rowPaginationFeature,
  createSortedRowModel,
  createPaginatedRowModel,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { getOrganizations, type OrganizationDto } from '@/api/client'
import type { SessionUser } from '@/api/auth'
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

const columnDefs: ColumnDef<typeof features, OrganizationDto>[] = [
  {
    accessorKey: 'tenantId',
    header: 'ID',
    cell: ({ row }) => {
      const value = row.getValue<string>('tenantId')
      return (
        <span className="font-mono text-xs text-muted-foreground">{String(value ?? '').slice(0, 8)}…</span>
      )
    },
  },
  {
    accessorKey: 'name',
    header: 'Nome',
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.getValue<string>('name')}</span>,
  },
  {
    accessorKey: 'document',
    header: 'Documento',
    cell: ({ row }) => {
      const value = row.getValue<string | null>('document')
      return value ? (
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      ) : (
        <span className="text-xs text-muted-foreground/50">—</span>
      )
    },
  },
  {
    accessorKey: 'createdAt',
    header: 'Criado em',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {new Date(String(row.getValue<string>('createdAt'))).toLocaleDateString('pt-BR')}
      </span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => {
      const status = String(row.getValue<string>('status') ?? '')
      return (
        <BUIBadge color="neutral" className={STATUS_CLASS[status] ?? ''}>
          {STATUS_LABELS[status] ?? status}
        </BUIBadge>
      )
    },
  },
  {
    id: 'actions',
    header: 'Ações',
    cell: ({ row }) => {
      const org = row.original
      return (
        <div className="flex items-center gap-2">
          <BUIButton
            variant="ghost"
            size="xs"
            onClick={() => {
              alert(`Organização: ${org.name}\nID: ${org.tenantId}\nStatus: ${org.status}`)
            }}
          >
            Ver
          </BUIButton>
        </div>
      )
    },
  },
]

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  readonly icon: React.ReactNode
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

export default function OrganizationsPage({
  user,
  onNavigate,
}: {
  user?: SessionUser
  onNavigate?: (page: string) => void
}) {
  const [search, setSearch] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }])
  const [userRole, setUserRole] = useState<string>('user')

  useEffect(() => {
    setUserRole(user?.role ?? 'user')
  }, [user?.role])

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
        (o) =>
          o.name.toLowerCase().includes(search.toLowerCase()) ||
          (o.document ?? '').toLowerCase().includes(search.toLowerCase()) ||
          o.tenantId.toLowerCase().includes(search.toLowerCase()),
      ),
    [organizations, search],
  )

  const table = useTable({
    features,
    columns: columnDefs,
    data: filtered,
    initialState: {
      sorting,
      pagination: { pageIndex, pageSize: PAGE_SIZE },
    },
    onSortingChange: setSorting,
    onPaginationChange: (updater) =>
      setPageIndex((prev) => {
        const next =
          typeof updater === 'function' ? updater({ pageIndex: prev, pageSize: PAGE_SIZE }) : updater
        return next.pageIndex
      }),
  })

  const total = organizations.length
  const activeCount = organizations.filter((o) => o.status === 'active').length
  const pendingCount = organizations.filter((o) => o.status === 'pending').length
  const suspendedCount = organizations.filter((o) => o.status === 'suspended').length

  const pageData = table.getRowModel().rows
  const totalPages = Math.max(1, table.getPageCount())

  const handleCreate = useCallback(() => {
    alert('Cadastro de organização em breve')
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
    setPageIndex(0)
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Organizações</h1>
          <p className="text-sm text-muted-foreground">Gerencie as organizações do sistema</p>
          </div>

          <div className="flex items-center gap-2 w-full lg:w-auto">
            <div className="relative flex-1 lg:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <BUIInput
                placeholder="Buscar organização…"
                value={search}
                onChange={handleSearchChange}
                className="pl-9"
              />
            </div>
            <BUIButton onClick={handleCreate}>
              <Building2 className="h-4 w-4 mr-2" />
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
              <BUITableHeader>
                {table.getHeaderGroups().flatMap((group) =>
                  group.headers.map((header) => (
                    <BUITableColumn
                      key={header.id}
                      isRowHeader={header.index === 0}
                      onClick={() => {
                        if (header.column.getCanSort()) {
                          header.column.toggleSorting()
                        }
                      }}
                      className={cn(
                        'cursor-pointer font-medium select-none',
                        header.column.getCanSort() ? 'hover:bg-accent/50' : undefined,
                      )}
                      data-sorted={
                        header.column.getIsSorted()
                          ? header.column.getIsSorted() === 'desc'
                            ? 'desc'
                            : 'asc'
                          : undefined
                      }
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() && (header.column.getIsSorted() === 'desc' ? ' ▼' : ' ▲')}
                    </BUITableColumn>
                  )),
                )}
              </BUITableHeader>
              <BUITableBody>
                {pageData.map((row) => (
                  <BUITableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <BUITableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </BUITableCell>
                    ))}
                  </BUITableRow>
                ))}
              </BUITableBody>
            </BUITable>
          </div>
        </div>

        {filtered.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm font-medium text-muted-foreground">Nenhuma organização encontrada</p>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Exibindo {Math.min(pageIndex * PAGE_SIZE + 1, filtered.length)}
              {'-'}
              {Math.min((pageIndex + 1) * PAGE_SIZE, filtered.length)} de {filtered.length} resultados
            </p>
            <BUIPagination
              page={pageIndex + 1}
              totalPages={totalPages}
              onChange={(p: number) => setPageIndex(p - 1)}
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
  )
}
