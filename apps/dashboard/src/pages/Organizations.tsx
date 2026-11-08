'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createOrganization, getOrganizations, getTermsVersion, type OrganizationDto } from '@/api/client'
import type { SessionUser } from '@/api/auth'
import { DataGrid, type DataGridColumn } from '@/components/application/data-grid/data-grid'
import { BUIBadge } from '@/components/ui'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal'
import { Input } from '@/components/base/input/input'
import { Button } from '@/components/base/buttons/button'
import { Card, CardContent } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Building2, Users, Clock, CircleAlert, FileText, AlertTriangle, RefreshCw } from 'lucide-react'

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
  {
    key: 'document',
    header: 'Documento',
    width: 180,
    format: (value) => {
      const v = String(value ?? '').trim()
      return v ? v : '—'
    },
  },
  {
    key: 'createdAt',
    header: 'Criado em',
    width: 160,
    format: (value) => new Date(String(value)).toLocaleDateString('pt-BR'),
  },
  {
    key: 'status',
    header: 'Status',
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
  user: _user,
  onNavigate: _onNavigate,
}: {
  user?: SessionUser
  onNavigate?: (page: string) => void
}) {
  useEffect(() => {}, [])

  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [toastPhase, setToastPhase] = useState<'hidden' | 'shown' | 'leaving'>('hidden')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const nameRef = useRef<HTMLInputElement>(null)
  const legalNameRef = useRef<HTMLInputElement>(null)
  const documentRef = useRef<HTMLInputElement>(null)
  const dataRegionRef = useRef<HTMLInputElement>(null)

  const showSuccessToast = () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToastPhase('shown')
    toastTimer.current = setTimeout(() => {
      setToastPhase('leaving')
      toastTimer.current = setTimeout(() => setToastPhase('hidden'), 220)
    }, 2000)
  }

  const organizationsQuery = useQuery({
    queryKey: ['organizations'],
    queryFn: getOrganizations,
    staleTime: 30_000,
    enabled: !!_user,
  })

  const termsQuery = useQuery({
    queryKey: ['terms-version'],
    queryFn: getTermsVersion,
    staleTime: 5 * 60_000,
  })

  const { data: organizations = [], isLoading, error } = organizationsQuery

  const total = organizations.length
  const activeCount = organizations.filter((o) => o.status === 'active').length
  const pendingCount = organizations.filter((o) => o.status === 'pending').length
  const suspendedCount = organizations.filter((o) => o.status === 'suspended').length

  const columns = useMemo(() => COLUMNS, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError(null)
    setIsCreating(true)
    try {
      const termsVersion = termsQuery.data?.version ?? null
      if (!termsVersion) {
        throw new Error('Versão dos termos não disponível. Tente novamente mais tarde.')
      }
      await createOrganization({
        name: nameRef.current?.value.trim() ?? '',
        legalName: legalNameRef.current?.value.trim() || null,
        document: documentRef.current?.value.trim() || null,
        termsVersion,
        dataRegion: dataRegionRef.current?.value.trim() || 'sa-east-1',
      })
      setCreateError(null)
      setIsCreateOpen(false)
      showSuccessToast()
      void organizationsQuery.refetch()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Erro ao criar organização.')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Erro de API: aviso no topo, não esconde nada */}
      {error && (
        <div className="rounded-xl border border-border-error-default bg-red-50 p-3 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="size-5 shrink-0 text-red-600" />
            <div>
              <p className="text-sm font-medium text-red-800">Não foi possível carregar as organizações</p>
              {error instanceof Error && error.message.includes('HTTP 500') && (
                <p className="text-xs text-red-600 mt-1">
                  O servidor retornou um erro inesperado. Verifique se a API está rodando.
                </p>
              )}
              {!isServerError(error) && (
                <p className="text-xs text-red-600 mt-1">
                  {error instanceof Error ? error.message : 'Erro inesperado'}
                </p>
              )}
              <button
                onClick={() => {
                  void organizationsQuery.refetch()
                }}
                className="mt-2 inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
              >
                <RefreshCw className="size-3.5" /> Tentar novamente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast de sucesso */}
      {toastPhase !== 'hidden' && (
        <div
          className={cn(
            'fixed top-6 left-1/2 -translate-x-1/2 z-100 flex w-[420px] flex-col items-center gap-2 rounded-xl border border-border-button-default bg-background-primary-default p-4 shadow-xl transition-all duration-300 ease-out',
            toastPhase === 'shown' && 'opacity-100 translate-y-0',
            toastPhase === 'leaving' && 'opacity-0 translate-y-[-12px] pointer-events-none',
          )}
        >
          <div className="flex items-center gap-2">
            <Building2 className="size-5 shrink-0 text-emerald-600" />
            <p className="text-body-regular text-text-primary">Organização criada com sucesso.</p>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Organizações</h1>
          <p className="text-sm text-muted-foreground">Gerencie as organizações do sistema</p>
        </div>

        <div className="flex items-center gap-2 w-full lg:w-auto">
          <Button
            variant="primary"
            leadingIcon={Building2}
            onClick={() => {
              setCreateError(null)
              setIsCreateOpen(true)
            }}
          >
            Nova organização
          </Button>
          <Modal isOpen={isCreateOpen} onOpenChange={setIsCreateOpen} size="md">
            {({ close }) => (
              <>
                <ModalHeader
                  title="Nova organização"
                  description="Cadastre os dados básicos da empresa. O onboarding completo será finalizado pela própria empresa pelo dashboard do verifier."
                  icon={Building2}
                  showCloseButton
                />
                <ModalBody>
                  <form onSubmit={handleSubmit}>
                    <Input
                      ref={nameRef}
                      label="Nome da organização"
                      placeholder="Ex: Comprova Endereço"
                      defaultValue=""
                    />
                    <Input
                      ref={legalNameRef}
                      label="Nome legal (opcional)"
                      placeholder="Ex: Comprova Endereço Ltda."
                      defaultValue=""
                    />
                    <Input
                      ref={documentRef}
                      label="Documento CNPJ (opcional)"
                      placeholder="Ex: 12.345.678/0001-90"
                      defaultValue=""
                    />
                    <Input ref={dataRegionRef} label="Região de dados" defaultValue="sa-east-1" />
                    <Input
                      label="Versão dos termos"
                      defaultValue={termsQuery.data?.version ?? '—'}
                      isDisabled
                    />
                    {createError && <p className="mt-2 text-sm text-text-error-primary">{createError}</p>}
                    <ModalFooter>
                      <Button variant="secondary" onClick={() => close()}>
                        Cancelar
                      </Button>
                      <Button
                        variant="primary"
                        type="submit"
                        disabled={isCreating || !termsQuery.data?.version}
                      >
                        {isCreating ? 'Criando…' : 'Criar organização'}
                      </Button>
                    </ModalFooter>
                  </form>
                </ModalBody>
              </>
            )}
          </Modal>
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
        {isLoading ? (
          <div className="flex h-[520px] items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 rounded-full border-2 border-border border-t-transparent animate-spin" />
              <p className="text-xs text-muted-foreground">Carregando organizações…</p>
            </div>
          </div>
        ) : organizations.length === 0 ? (
          <div className="flex h-[300px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background-secondary p-8 text-center">
            <Building2 className="mb-2 size-6 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">Nenhuma organização cadastrada</p>
            <p className="mt-1 text-xs text-muted-foreground/70">Ainda não há organizações no sistema.</p>
          </div>
        ) : (
          <DataGrid
            aria-label="Organizações"
            data={organizations}
            columns={columns}
            getRowId={(row) => row.tenantId}
            height={520}
          />
        )}
      </div>
    </div>
  )
}

function isServerError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('HTTP 500')
}
