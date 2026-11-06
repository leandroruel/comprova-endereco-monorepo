import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getOrganizations, getStats, type OrganizationDto } from '@/api/client'
import { authClient, type SessionUser } from '@/api/auth'
import { BUIBadge, BUIButton } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Building2,
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  RefreshCw,
  TrendingUp,
  Users,
  XCircle,
} from 'lucide-react'

const MONTHS_SHORT = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
] as const

const numberFormat = new Intl.NumberFormat('pt-BR')

const formatNumber = (value: number): string => numberFormat.format(value)

/** `avg_confidence` chega como 0…1; `avg_score` pode vir como 0…1 ou absoluto. */
const formatRate = (value: number | undefined): string => {
  if (value === undefined || Number.isNaN(value)) return '—'
  const rate = value <= 1 ? value * 100 : value
  return `${Math.round(rate)}%`
}

const relativeDate = (iso: string): string => {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return '—'
  const diffMs = then.getTime() - Date.now()
  const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
  const minutes = Math.round(diffMs / 60_000)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return formatter.format(days, 'day')
  const months = Math.round(days / 30)
  if (Math.abs(months) < 12) return formatter.format(months, 'month')
  return formatter.format(Math.round(months / 12), 'year')
}

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase() || '?'
}

const AVATAR_GRADIENTS = [
  'from-accent-400 to-accent-700',
  'from-emerald-400 to-emerald-700',
  'from-amber-400 to-amber-700',
  'from-fuchsia-400 to-purple-700',
] as const

const ORG_STATUS: Readonly<Record<string, { label: string; className: string }>> = {
  active: {
    label: 'Ativo',
    className: 'border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-800',
  },
  pending: {
    label: 'Pendente',
    className: 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800',
  },
  onboarding: {
    label: 'Onboarding',
    className: 'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-800',
  },
  suspended: {
    label: 'Suspenso',
    className: 'border-red-200 bg-red-100 text-red-800 dark:border-red-800',
  },
  inactive: {
    label: 'Inativo',
    className: 'border-border bg-muted text-muted-foreground',
  },
}

interface VerdictMeta {
  readonly label: string
  readonly color: string
}

const VERDICT_META: Readonly<Record<string, VerdictMeta>> = {
  CONFIRMED_COMMERCIAL: { label: 'Confirmado', color: 'var(--color-chart-2)' },
  INSUFFICIENT_EVIDENCE: { label: 'Evidência insuficiente', color: 'var(--color-chart-8)' },
  NOT_FOUND: { label: 'Não encontrado', color: 'var(--color-chart-3)' },
  INCONSISTENT: { label: 'Inconsistente', color: 'var(--color-chart-1)' },
  PENDING: { label: 'Pendente', color: 'var(--color-chart-6)' },
}

type ChartMode = 'verdict' | 'status' | 'document'
type GrowthRange = '6m' | '12m' | 'all'

const CHART_MODES: readonly { id: ChartMode; label: string }[] = [
  { id: 'verdict', label: 'Vereditos' },
  { id: 'status', label: 'Status' },
  { id: 'document', label: 'Documentos' },
]

const GROWTH_RANGES: readonly { id: GrowthRange; label: string }[] = [
  { id: '6m', label: '6M' },
  { id: '12m', label: '12M' },
  { id: 'all', label: 'Tudo' },
]

const CHART_TITLES: Readonly<Record<ChartMode, string>> = {
  verdict: 'Validações por veredito',
  status: 'Validações por status',
  document: 'Validações por documento',
}

const tooltipStyle = {
  background: 'var(--color-card)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  fontSize: 12,
  color: 'var(--color-foreground)',
  boxShadow: 'var(--shadow-md)',
} as const

interface SeriesPoint {
  readonly label: string
  readonly value: number
  readonly color: string
}

function buildMonthlySeries(
  organizations: readonly OrganizationDto[],
  range: GrowthRange,
): readonly { label: string; value: number }[] {
  const now = new Date()
  let months = range === '6m' ? 6 : 12

  if (range === 'all') {
    const oldest = organizations.reduce<string | null>((earliest, org) => {
      if (earliest === null) return org.createdAt
      return org.createdAt < earliest ? org.createdAt : earliest
    }, null)
    if (oldest !== null) {
      const date = new Date(oldest)
      months = Math.max(
        1,
        (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth()) + 1,
      )
      months = Math.min(months, 24)
    }
  }

  const buckets = new Map<string, number>()
  for (let index = months - 1; index >= 0; index -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1)
    buckets.set(`${date.getFullYear()}-${date.getMonth()}`, 0)
  }

  for (const organization of organizations) {
    const date = new Date(organization.createdAt)
    if (Number.isNaN(date.getTime())) continue
    const key = `${date.getFullYear()}-${date.getMonth()}`
    const current = buckets.get(key)
    if (current !== undefined) buckets.set(key, current + 1)
  }

  return Array.from(buckets, ([key, value]) => {
    const month = Number(key.split('-')[1])
    return { label: MONTHS_SHORT[month] ?? key, value }
  })
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  readonly value: T
  readonly options: readonly { id: T; label: string }[]
  readonly onChange: (value: T) => void
  readonly label: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors motion-reduce:transition-none',
            value === option.id
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Panel({
  children,
  className,
}: {
  readonly children: React.ReactNode
  readonly className?: string
}) {
  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5 shadow-sm', className)}>
      {children}
    </section>
  )
}

function PanelHeading({
  title,
  description,
  action,
}: {
  readonly title: string
  readonly description?: string
  readonly action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {description !== undefined && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}

function ChartEmpty({ message }: { readonly message: string }) {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-border text-center">
      <FileText className="mb-2 size-6 text-muted-foreground/40" />
      <p className="text-xs font-medium text-muted-foreground">{message}</p>
    </div>
  )
}

export default function HomePage({
  user,
  onNavigate,
}: {
  readonly user?: SessionUser
  readonly onNavigate?: (page: string) => void
}) {
  const [chartMode, setChartMode] = useState<ChartMode>('verdict')
  const [growthRange, setGrowthRange] = useState<GrowthRange>('12m')
  const [orgPage, setOrgPage] = useState(0)
  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const organizationsQuery = useQuery({
    queryKey: ['organizations'],
    queryFn: getOrganizations,
    staleTime: 30_000,
    enabled: user !== undefined,
  })

  const stats = statsQuery.data

  const sortedOrganizations = useMemo(
    () =>
      [...(organizationsQuery.data ?? [])].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [organizationsQuery.data],
  )

  const organizationsPerPage = 4
  const totalOrganizationPages = Math.max(
    1,
    Math.ceil(sortedOrganizations.length / organizationsPerPage),
  )
  const safeOrganizationPage = Math.min(orgPage, totalOrganizationPages - 1)
  const visibleOrganizations = sortedOrganizations.slice(
    safeOrganizationPage * organizationsPerPage,
    safeOrganizationPage * organizationsPerPage + organizationsPerPage,
  )

  const chartSeries = useMemo<Readonly<Record<ChartMode, readonly SeriesPoint[]>>>(() => {
    if (stats === undefined) return { verdict: [], status: [], document: [] }
    return {
      verdict: Object.entries(VERDICT_META).map(([key, meta]) => ({
        label: meta.label,
        value: stats.by_verdict[key] ?? 0,
        color: meta.color,
      })),
      status: [
        { label: 'Concluídas', value: stats.completed, color: 'var(--color-chart-2)' },
        { label: 'Parciais', value: stats.partial, color: 'var(--color-chart-8)' },
        { label: 'Falhas', value: stats.failed, color: 'var(--color-chart-3)' },
      ],
      document: [
        { label: 'CNPJ', value: stats.by_doc_type['CNPJ'] ?? 0, color: 'var(--color-chart-6)' },
        { label: 'CPF', value: stats.by_doc_type['CPF'] ?? 0, color: 'var(--color-chart-5)' },
      ],
    }
  }, [stats])

  const currentSeries = chartSeries[chartMode]
  const seriesTotal = currentSeries.reduce((total, point) => total + point.value, 0)

  const growthSeries = useMemo(
    () => buildMonthlySeries(sortedOrganizations, growthRange),
    [sortedOrganizations, growthRange],
  )
  const currentMonth = growthSeries.at(-1)?.value ?? 0
  const previousMonth = growthSeries.at(-2)?.value ?? 0
  const growthDelta =
    previousMonth > 0 ? Math.round(((currentMonth - previousMonth) / previousMonth) * 100) : null

  const completionRate =
    stats !== undefined && stats.total > 0 ? stats.completed / stats.total : 0

  const statusPie = useMemo(
    () =>
      stats === undefined
        ? []
        : [
            { name: 'Concluídas', value: stats.completed, color: 'var(--color-chart-2)' },
            { name: 'Parciais', value: stats.partial, color: 'var(--color-chart-8)' },
            { name: 'Falhas', value: stats.failed, color: 'var(--color-chart-3)' },
          ].filter((entry) => entry.value > 0),
    [stats],
  )

  const qualityChips = [
    { label: 'Docs únicos', value: stats?.unique_documents ?? 0, icon: Users },
    { label: 'Concluídas', value: stats?.completed ?? 0, icon: CheckCircle2 },
    { label: 'Parciais', value: stats?.partial ?? 0, icon: Clock },
    { label: 'Falhas', value: stats?.failed ?? 0, icon: XCircle },
  ] as const

  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || 'por aqui'

  const refresh = () => {
    void statsQuery.refetch()
    void organizationsQuery.refetch()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Bem-vindo, {displayName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe validações, organizações e a qualidade das evidências em tempo real.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Notificações"
            className="relative flex size-9 items-center justify-center rounded-2lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <Bell className="size-4" />
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-red-500 ring-2 ring-card" />
          </button>
          <BUIButton
            variant="secondary"
            leadingIcon={RefreshCw}
            onClick={refresh}
            disabled={statsQuery.isFetching || organizationsQuery.isFetching}
          >
            Atualizar
          </BUIButton>
          <BUIButton
            variant="primary"
            leadingIcon={Plus}
            onClick={() => onNavigate?.('validations')}
          >
            Nova validação
          </BUIButton>
        </div>
      </div>

        <div className="grid gap-4 xl:grid-cols-12">
          <Panel className="xl:col-span-5">
            <PanelHeading
              title="Organizações recentes"
              description="Cadastradas na plataforma"
              action={
                <BUIButton
                  variant="secondary"
                  size="xs"
                  onClick={() => onNavigate?.('organizations')}
                >
                  Ver todas
                </BUIButton>
              }
            />

            <div className="mt-2 flex items-end gap-2">
              <span className="font-mono text-3xl font-semibold tabular-nums leading-none text-foreground">
                {organizationsQuery.isLoading ? '—' : formatNumber(sortedOrganizations.length)}
              </span>
              <span className="pb-0.5 text-[11px] text-muted-foreground">organizações</span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {visibleOrganizations.map((organization, index) => {
                const status = ORG_STATUS[organization.status] ?? {
                  label: organization.status,
                  className: 'border-border bg-muted text-muted-foreground',
                }
                const gradient = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length]
                return (
                  <article
                    key={organization.tenantId}
                    className="rounded-xl border border-border bg-background/60 p-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white',
                          gradient,
                        )}
                      >
                        {initialsOf(organization.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {organization.name}
                        </p>
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {relativeDate(organization.createdAt)}
                          {organization.document !== null && ` · ${organization.document}`}
                        </p>
                        <BUIBadge color="neutral" className={cn('mt-2', status.className)}>
                          {status.label}
                        </BUIBadge>
                      </div>
                    </div>
                  </article>
                )
              })}

              {!organizationsQuery.isLoading && visibleOrganizations.length === 0 && (
                <div className="col-span-full flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-8 text-center">
                  <Building2 className="mb-2 size-6 text-muted-foreground/40" />
                  <p className="text-xs font-medium text-muted-foreground">
                    Nenhuma organização cadastrada
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    Cadastre uma organização para vê-la aqui
                  </p>
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <BUIButton
                variant="secondary"
                size="small"
                leadingIcon={ArrowLeft}
                className="w-full"
                disabled={safeOrganizationPage === 0}
                onClick={() => setOrgPage((page) => Math.max(0, page - 1))}
              >
                Anterior
              </BUIButton>
              <BUIButton
                variant="secondary"
                size="small"
                trailingIcon={ArrowRight}
                className="w-full"
                disabled={safeOrganizationPage >= totalOrganizationPages - 1}
                onClick={() =>
                  setOrgPage((page) => Math.min(totalOrganizationPages - 1, page + 1))
                }
              >
                Próximo
              </BUIButton>
            </div>
          </Panel>

          <Panel className="xl:col-span-7">
            <PanelHeading
              title={CHART_TITLES[chartMode]}
              description="Distribuição das validações do seu tenant"
              action={
                <SegmentedControl
                  label="Agrupar validações"
                  value={chartMode}
                  options={CHART_MODES}
                  onChange={setChartMode}
                />
              }
            />

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <span className="font-mono text-3xl font-semibold tabular-nums leading-none text-foreground">
                {statsQuery.isLoading ? '—' : formatNumber(seriesTotal)}
              </span>
              {stats !== undefined && stats.total > 0 && (
                <span className="inline-flex items-center gap-1 pb-0.5 text-[11px] font-medium text-emerald-600">
                  <TrendingUp className="size-3" />
                  {formatRate(completionRate)} concluídas
                </span>
              )}
            </div>

            <div className="mt-3">
              {statsQuery.isLoading ? (
                <div className="h-[240px] animate-pulse rounded-xl bg-muted" />
              ) : seriesTotal === 0 ? (
                <ChartEmpty message="Sem validações registradas ainda" />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart
                    data={[...currentSeries]}
                    margin={{ top: 8, right: 4, left: -20, bottom: 0 }}
                    barCategoryGap="30%"
                  >
                    <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="4 4" />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }}
                    />
                    <Tooltip
                      cursor={{ fill: 'var(--color-accent)', opacity: 0.35 }}
                      contentStyle={tooltipStyle}
                      labelStyle={{ color: 'var(--color-muted-foreground)' }}
                      formatter={(value) => [formatNumber(Number(value)), 'Validações']}
                    />
                    <Bar dataKey="value" radius={[6, 6, 6, 6]} background={{ fill: 'var(--color-muted)' }}>
                      {currentSeries.map((point) => (
                        <Cell key={point.label} fill={point.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Panel>
        </div>

        <div className="grid gap-4 xl:grid-cols-12">
          <Panel className="xl:col-span-7">
            <PanelHeading
              title="Organizações ao longo do tempo"
              description="Novas organizações por mês"
              action={
                <SegmentedControl
                  label="Período"
                  value={growthRange}
                  options={GROWTH_RANGES}
                  onChange={setGrowthRange}
                />
              }
            />

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <span className="font-mono text-3xl font-semibold tabular-nums leading-none text-foreground">
                {organizationsQuery.isLoading ? '—' : formatNumber(sortedOrganizations.length)}
              </span>
              {growthDelta !== null && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 pb-0.5 text-[11px] font-medium',
                    growthDelta >= 0 ? 'text-emerald-600' : 'text-red-600',
                  )}
                >
                  <TrendingUp className={cn('size-3', growthDelta < 0 && 'rotate-180')} />
                  {growthDelta >= 0 ? '+' : ''}
                  {growthDelta}% no mês
                </span>
              )}
            </div>

            <div className="mt-3">
              {organizationsQuery.isLoading ? (
                <div className="h-[220px] animate-pulse rounded-xl bg-muted" />
              ) : sortedOrganizations.length === 0 ? (
                <ChartEmpty message="Sem organizações para exibir" />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart
                    data={[...growthSeries]}
                    margin={{ top: 8, right: 4, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="organizationGrowth" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-accent-500)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--color-accent-500)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="4 4" />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelStyle={{ color: 'var(--color-muted-foreground)' }}
                      formatter={(value) => [formatNumber(Number(value)), 'Organizações']}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--color-accent-500)"
                      strokeWidth={2}
                      fill="url(#organizationGrowth)"
                      activeDot={{ r: 4 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Panel>

          <Panel className="xl:col-span-5">
            <PanelHeading
              title="Qualidade das validações"
              description="Confiança média e andamento"
              action={
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {formatRate(stats?.avg_confidence)}
                </span>
              }
            />

            <div className="mt-4 grid items-center gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
              <div className="relative mx-auto h-[150px] w-[150px]">
                {statusPie.length > 0 && (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={statusPie}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={48}
                        outerRadius={66}
                        paddingAngle={3}
                        stroke="none"
                      >
                        {statusPie.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value) => [formatNumber(Number(value)), 'Validações']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {statsQuery.isLoading ? '—' : formatNumber(stats?.total ?? 0)}
                  </span>
                  <span className="text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
                    total
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                {statusPie.map((entry) => (
                  <div key={entry.name} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: entry.color }}
                      />
                      {entry.name}
                    </span>
                    <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                      {formatNumber(entry.value)}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                  <span className="text-xs text-muted-foreground">Confiança média</span>
                  <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                    {formatRate(stats?.avg_confidence)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Score médio</span>
                  <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                    {stats === undefined ? '—' : stats.avg_score.toFixed(2)}
                  </span>
                </div>
                {statsQuery.isError && (
                  <p className="flex items-center gap-1.5 text-[11px] text-red-600">
                    <AlertTriangle className="size-3.5" />
                    Não foi possível carregar as métricas
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {qualityChips.map((chip) => {
                const Icon = chip.icon
                return (
                  <div key={chip.label} className="rounded-xl border border-border bg-background/60 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Icon className="size-3" />
                      <span className="truncate">{chip.label}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                      {statsQuery.isLoading ? '—' : formatNumber(chip.value)}
                    </p>
                  </div>
                )
              })}
            </div>
          </Panel>
        </div>
      </div>
  )
}
