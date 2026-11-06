'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOrganizations, type OrganizationDto } from '@/api/client'
import type { SessionUser } from '@/api/auth'
import { DataGrid, type DataGridColumn } from '@/components/application/data-grid/data-grid'
import { BUIBadge, BUIButton } from '@/components/ui'
import { Card, CardContent } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Building2, Users, Clock, CircleAlert, FileText } from 'lucide-react'

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

const COLUMNS: DataGridColumn<OrganizationDto>[] = [
  { key: 'tenantId', header: 'ID', width: 200, format: (value) => String(value ?? '').slice(0, 8) + '…' },
  { key: 'name', header: 'Nome', width: 260 },
  { key: 'document', header: 'Documento', width: 180, format: (value) => value ?? '—' },
  { key: 'createdAt', header: 'Criado em', width: 160, format: (value) => new Date(String(value)).toLocaleDateString('pt-BR') },
  {
    key: 'status',
    header: 'Status',
    width: 150,
    format: (value) => {
      const status = String(value ?? '')
      return (
        <BUIBadge color="neutral" className={STATUS_CLASS[status] ?? ''}>
          {STATUS_LABELS[status] ?? status}
        </BUIBadge>
      )
    },
  },
]

export default function OrganizationsPage({
  user,
  onNavigate,
}: {
  user?: SessionUser
  onNavigate?: (page: string) => void
}) {
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

  const total = organizations.length
  const activeCount = organizations.filter((o) => o.status === 'active').length
  const pendingCount = organizations.filter((o) => o.status === 'pending').length
  const suspendedCount = organizations.filter((o) => o.status === 'suspended').length

  const columns = useMemo(() => COLUMNS, [])

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Organizações</h1>
          <p className="text-sm text-muted-foreground">Gerencie as organizações do sistema</p>
        </div>

        <div className="flex items-center gap-2 w-full lg:w-auto">
          <BUIButton
            onClick={() => alert('Cadastro de organização em breve')}
          >
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

      <div className="rounded-2xl border border-border-button-default bg-background-primary-default shadow-sm">
        <DataGrid
          aria-label="Organizações"
          data={organizations}
          columns={columns}
          getRowId={(row) => row.tenantId}
          height={520}
        />
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Erro ao carregar organizações'}
        </p>
      )}
    </div>
  )
}
