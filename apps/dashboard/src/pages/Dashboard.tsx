import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createValidation, getStats, type ValidationDto } from '@/api/client'
import { authClient } from '@/api/auth'
import { DashboardLayout } from '@/components/layout'
import { ValidationCard } from '@/components/validation-card'
import { E2eRunner } from '@/components/validation/e2e-runner'
import { Button, Card, CardContent, Input, Spinner } from '@/components/ui'
import { LoginPage } from '@/pages/Login'
import { Activity, CheckCircle2, Search, Timer, Users, XCircle } from 'lucide-react'

const VLM_ENABLED = false

const MODES: readonly ('fast' | 'auto' | 'deep')[] = VLM_ENABLED ? ['fast', 'auto', 'deep'] : ['fast']

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

export default function Dashboard({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const [session, setSession] = useState<{ user: { email: string; name: string; role?: string } } | null>(
    null,
  )
  const [userRole, setUserRole] = useState<string>('user')
  const [authChecked, setAuthChecked] = useState(false)
  const [document, setDocument] = useState('')
  const [mode, setMode] = useState<'fast' | 'auto' | 'deep'>('fast')
  const [history, setHistory] = useState<ValidationDto[]>([])
  const queryClient = useQueryClient()

  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  })

  const mutation = useMutation({
    mutationFn: () => createValidation(document, mode),
    onSuccess: (result) => {
      setHistory((prev) => [result, ...prev])
      setDocument('')
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  useEffect(() => {
    if (authChecked) return
    void authClient.getSession().then((result) => {
      if (result.data) {
        const user = result.data.user as { readonly role?: string | null }
        setSession(result.data)
        setUserRole(user.role ?? 'user')
      }
      setAuthChecked(true)
    })
  }, [authChecked])

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner />
      </div>
    )
  }

  if (!session) {
    return (
      <LoginPage onSuccess={() => void authClient.getSession().then((r) => r.data && setSession(r.data))} />
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

  const handleNavigate = (page: string) => {
    onNavigate?.(page)
  }

  return (
    <DashboardLayout
      activePage="validations"
      onNavigate={handleNavigate}
      userEmail={session.user.name}
      userRole={userRole}
      onLogout={() => {
        void authClient.signOut().then(() => {
          setSession(null)
          setHistory([])
        })
      }}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Validação de endereço</h1>
            <p className="text-sm text-muted-foreground">
              Verifica CNPJ ou CPF contra múltiplas fontes de evidência
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={<Activity className="h-4 w-4 text-foreground/60" />}
            label="Consultas"
            value={stats.isLoading ? '—' : String(s?.total ?? 0)}
            sub={s ? `${uniqueDocs} doc${uniqueDocs === 1 ? '' : 's'} · ${s.completed} completas` : undefined}
          />
          <StatCard
            icon={<Users className="h-4 w-4 text-blue-600" />}
            label="CNPJ / CPF"
            value={stats.isLoading ? '—' : `${cnpjCount}/${cpfCount}`}
            sub={`${uniqueDocs} documento${uniqueDocs === 1 ? '' : 's'} único${uniqueDocs === 1 ? '' : 's'}`}
            accent="bg-blue-50"
          />
          <StatCard
            icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            label="Bem sucedidas"
            value={stats.isLoading ? '—' : String(confirmedCount)}
            sub={s && s.total > 0 ? `${((confirmedCount / s.total) * 100).toFixed(0)}% do total` : undefined}
            accent="bg-emerald-50"
          />
          <StatCard
            icon={<XCircle className="h-4 w-4 text-red-600" />}
            label="Não sucedidas"
            value={stats.isLoading ? '—' : String(unsuccessful)}
            sub={s && s.total > 0 ? `${((unsuccessful / s.total) * 100).toFixed(0)}% do total` : undefined}
            accent="bg-red-50"
          />
        </div>

        <Card>
          <CardContent className="p-4">
            <form
              className="flex flex-col gap-3 sm:flex-row"
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
              <div className="flex items-center gap-1 rounded-lg border border-input p-0.5">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {m === 'fast' ? '⚡ fast' : m === 'auto' ? '⚡+deep auto' : '🔍 deep'}
                  </button>
                ))}
              </div>
              <Button type="submit" disabled={mutation.isPending || !document.trim()} className="px-5">
                {mutation.isPending ? <Spinner /> : 'Validar'}
              </Button>
            </form>
            {mutation.isError && (
              <p className="mt-2 text-sm text-destructive">
                {mutation.error instanceof Error ? mutation.error.message : 'Erro desconhecido'}
              </p>
            )}
          </CardContent>
        </Card>

        <E2eRunner />

        <div className="space-y-4">
          {history.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Timer className="mb-3 h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm font-medium text-muted-foreground">Nenhuma validação nesta sessão</p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Digite um CNPJ acima e pressione Enter
                </p>
              </CardContent>
            </Card>
          )}
          {history.map((validation, index) => (
            <ValidationCard
              key={validation.validation_id}
              validation={validation}
              defaultCollapsed={index > 0}
            />
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
