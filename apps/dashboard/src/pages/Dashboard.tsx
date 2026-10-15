import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { createValidation, getReady, type ValidationDto } from '@/api/client'
import { DashboardLayout } from '@/components/layout'
import { ValidationCard } from '@/components/validation-card'
import { Button, Card, CardContent, Input, Spinner } from '@/components/ui'
import { CheckCircle2, FileSearch, Globe, Search, Timer, Zap } from 'lucide-react'

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">{icon}</div>
        <div className="flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-0.5 font-mono text-xl font-bold tabular-nums text-foreground">{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export default function Dashboard() {
  const [document, setDocument] = useState('')
  const [mode, setMode] = useState<'fast' | 'auto' | 'deep'>('fast')
  const [history, setHistory] = useState<ValidationDto[]>([])

  const health = useQuery({
    queryKey: ['health'],
    queryFn: getReady,
    refetchInterval: 15_000,
  })

  const mutation = useMutation({
    mutationFn: () => createValidation(document, mode),
    onSuccess: (result) => {
      setHistory((prev) => [result, ...prev])
      setDocument('')
    },
  })

  const totalValidations = history.length
  const confirmed = history.filter((v) => v.verdict === 'CONFIRMED_COMMERCIAL').length
  const avgConfidence =
    history.length > 0 ? (history.reduce((acc, v) => acc + (v.confidence ?? 0), 0) / history.length) * 100 : 0

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Validação de endereço</h1>
            <p className="text-sm text-muted-foreground">
              Verifica CNPJ ou CPF contra múltiplas fontes de evidência
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<FileSearch className="h-5 w-5 text-foreground/70" />}
            label="Validações (sessão)"
            value={String(totalValidations)}
          />
          <StatCard
            icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />}
            label="Confirmadas"
            value={String(confirmed)}
            sub={
              totalValidations > 0
                ? `${((confirmed / totalValidations) * 100).toFixed(0)}% do total`
                : undefined
            }
          />
          <StatCard
            icon={<Zap className="h-5 w-5 text-amber-600" />}
            label="Confiança média"
            value={`${avgConfidence.toFixed(0)}%`}
          />
          <StatCard
            icon={<Globe className="h-5 w-5 text-blue-600" />}
            label="API"
            value={health.data?.status === 'ok' ? 'online' : 'offline'}
            sub={health.isFetching ? 'verificando...' : 'sa-east-1 (dev)'}
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
                {(['fast', 'auto', 'deep'] as const).map((m) => (
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
          {history.map((validation) => (
            <ValidationCard key={validation.validation_id} validation={validation} />
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
