import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createValidation, getStats, type ValidationDto } from '@/api/client'
import { type SessionUser } from '@/api/auth'
import { ValidationCard } from '@/components/validation-card'
import { ConsoleFixedBottom } from '@/components/console/console-fixed-bottom'
import { E2eRunner } from '@/components/validation/e2e-runner'
import { Button, Card, CardContent, Input, Spinner } from '@/components/ui'
import { Tabs, TabList, Tab, TabPanel } from '@/components/base/tabs/tabs'
import { useAlerts } from '@/components/base/alert/alert-context'
import { Activity, CheckCircle2, Search, Timer, Users, XCircle } from 'lucide-react'
import { cx } from '@/utils/cx'

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accent ?? 'bg-muted'}`}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="font-mono text-2xl font-bold tabular-nums leading-tight text-foreground">{value}</p>
            {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function Validations({
  user,
  onNavigate,
}: {
  user?: SessionUser
  onNavigate?: (page: string) => void
}) {
  const [document, setDocument] = useState('')
  const [history, setHistory] = useState<ValidationDto[]>([])
  const queryClient = useQueryClient()
  const { add } = useAlerts()

  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    enabled: user?.role === 'admin',
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  })

  const mutation = useMutation({
    mutationFn: () => createValidation(document),
    onError: (error) => {
      add({
        variant: 'error',
        title: 'Falha ao validar',
        message: error instanceof Error ? error.message : 'Erro desconhecido',
      })
    },
    onSuccess: (result) => {
      setHistory((prev) => [result, ...prev])
      setDocument('')
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner />
      </div>
    )
  }

  const s = stats.data
  const cnpjCount = s?.by_doc_type?.['CNPJ'] ?? 0
  const cpfCount = s?.by_doc_type?.['CPF'] ?? 0
  const uniqueDocs = s?.unique_documents ?? 0
  const confirmedCount = s?.by_verdict?.['CONFIRMED_COMMERCIAL'] ?? 0
  const insuffCount = s?.by_verdict?.['INSUFFICIENT_EVIDENCE'] ?? 0
  const notFoundCount = s?.by_verdict?.['NOT_FOUND'] ?? 0
  const unsuccessful = insuffCount + notFoundCount + (s?.by_verdict?.['INCONSISTENT'] ?? 0)

  const apiStatus = stats.isLoading ? 'checking' : 'online'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Validação de endereço</h1>
          <p className="text-sm text-muted-foreground">
            Verificação de CNPJ/CPF contra múltiplas fontes de evidência oficiais
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cx(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
              apiStatus === 'online'
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : apiStatus === 'checking'
                  ? 'bg-muted text-muted-foreground border border-border-button-default'
                  : 'bg-red-50 text-red-800 border border-red-200',
            )}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${apiStatus === 'online' ? 'bg-emerald-500 animate-pulse' : apiStatus === 'checking' ? 'bg-muted-foreground animate-pulse' : 'bg-red-500'}`}
              aria-hidden
            />
            API Receita:{' '}
            {apiStatus === 'online' ? 'Online' : apiStatus === 'checking' ? 'Verificando…' : 'Offline'}
          </span>
          <Button variant="outline" size="sm" onClick={() => setDocument('')} disabled={mutation.isPending}>
            <XCircle className="size-3.5 mr-1.5" aria-hidden />
            Novo
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<Activity className="h-4 w-4 text-foreground/60" />}
          label="Consultas Totais"
          value={stats.isLoading ? '—' : String(s?.total ?? 0)}
          sub={s ? `${uniqueDocs} doc${uniqueDocs === 1 ? '' : 's'} · ${s.completed} completas` : undefined}
        />
        <StatCard
          icon={<Users className="h-4 w-4 text-blue-600" />}
          label="Documentos Únicos"
          value={stats.isLoading ? '—' : `${uniqueDocs}`}
          sub={`${cnpjCount + cpfCount} CNPJ/CPF`}
          accent="bg-blue-50"
        />
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
          label="Bem Sucedidas"
          value={stats.isLoading ? '—' : String(confirmedCount)}
          sub={s && s.total > 0 ? `${((confirmedCount / s.total) * 100).toFixed(0)}% do total` : undefined}
          accent="bg-emerald-50"
        />
        <StatCard
          icon={<XCircle className="h-4 w-4 text-red-600" />}
          label="Não Sucedidas"
          value={stats.isLoading ? '—' : String(unsuccessful)}
          sub={s && s.total > 0 ? `${((unsuccessful / s.total) * 100).toFixed(0)}% do total` : undefined}
          accent="bg-red-50"
        />
      </div>

      {/* Tabs */}
      <Tabs>
        <TabList className="w-full grid grid-cols-2">
          <Tab key="simple" className="flex-1 py-2.5 text-sm font-medium">
            Validação Simples
          </Tab>
          <Tab key="complete" className="flex-1 py-2.5 text-sm font-medium">
            Validação Completa + NF3e
          </Tab>
        </TabList>

        <TabPanel key="simple" className="mt-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="col-span-2">
              <Card>
                <CardContent className="p-5">
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (document.trim()) mutation.mutate()
                    }}
                  >
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="CNPJ ou CPF — ex: 33.986.733/0001-04"
                        value={document}
                        onChange={(e) => setDocument(e.target.value)}
                        className="pl-9 font-mono text-sm"
                      />
                    </div>
                    <div className="flex items-end gap-3">
                      <Button
                        type="submit"
                        disabled={mutation.isPending || !document.trim()}
                        className="px-6 py-2.5"
                      >
                        {mutation.isPending ? <Spinner /> : 'Executar Validação'}
                      </Button>
                    </div>
                  </form>
                  {mutation.isError && (
                    <p className="mt-2 text-sm text-destructive" role="alert">
                      {mutation.error instanceof Error ? mutation.error.message : 'Erro desconhecido'}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
            <div className="col-span-1">
              <Card>
                <CardContent className="p-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
                    Histórico desta sessão
                  </h3>
                  {history.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                      <Timer className="mb-2 h-6 w-6 text-muted-foreground/30" />
                      <p className="text-xs font-medium text-muted-foreground">
                        Nenhuma validação nesta sessão
                      </p>
                      <p className="mt-1 text-[10px] text-muted-foreground/70">
                        Digite um CNPJ acima e pressione Enter
                      </p>
                    </div>
                  )}
                  {history.map((validation, index) => (
                    <ValidationCard
                      key={validation.validation_id}
                      validation={validation}
                      defaultCollapsed={index > 0}
                    />
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabPanel>

        <TabPanel key="complete" className="mt-4">
          <E2eRunner />
        </TabPanel>
      </Tabs>

      {/* Console flutuante no rodapé */}
      <ConsoleFixedBottom />
    </div>
  )
}
