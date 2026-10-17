import type { ValidationDto } from '@/api/client'
import { Button, Card } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsUpDown,
  CircleHelp,
  CircleMinus,
  Copy,
  Info,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import {
  buildSnapshot,
  countStances,
  describeSignal,
  groupViews,
  type SignalView,
  type StanceCounts,
} from './humanize'
import {
  CLAIM_LABELS,
  FALLBACK_VERDICT,
  STANCES,
  VERDICTS,
  confidenceLevel,
  formatDate,
  formatPercent,
  formatRelative,
  formatTtl,
  type Stance,
  type Tone,
} from './meta'

interface ToneStyle {
  readonly hero: string
  readonly text: string
  readonly icon: string
  readonly fill: string
  readonly stroke: string
  readonly chip: string
}

const TONES: Readonly<Record<Tone, ToneStyle>> = {
  success: {
    hero: 'border-emerald-200 bg-emerald-50',
    text: 'text-emerald-800',
    icon: 'text-emerald-600',
    fill: 'bg-emerald-500',
    stroke: 'stroke-emerald-500',
    chip: 'bg-emerald-100 text-emerald-800',
  },
  warning: {
    hero: 'border-amber-200 bg-amber-50',
    text: 'text-amber-800',
    icon: 'text-amber-600',
    fill: 'bg-amber-500',
    stroke: 'stroke-amber-500',
    chip: 'bg-amber-100 text-amber-800',
  },
  danger: {
    hero: 'border-red-200 bg-red-50',
    text: 'text-red-800',
    icon: 'text-red-600',
    fill: 'bg-red-500',
    stroke: 'stroke-red-500',
    chip: 'bg-red-100 text-red-800',
  },
  info: {
    hero: 'border-blue-200 bg-blue-50',
    text: 'text-blue-800',
    icon: 'text-blue-600',
    fill: 'bg-blue-500',
    stroke: 'stroke-blue-500',
    chip: 'bg-blue-100 text-blue-800',
  },
  neutral: {
    hero: 'border-zinc-200 bg-zinc-50',
    text: 'text-zinc-700',
    icon: 'text-zinc-500',
    fill: 'bg-zinc-400',
    stroke: 'stroke-zinc-400',
    chip: 'bg-zinc-100 text-zinc-700',
  },
}

const STANCE_ICON: Readonly<Record<Stance, typeof CheckCircle2>> = {
  supports: CheckCircle2,
  contradicts: XCircle,
  neutral: CircleMinus,
  unknown: CircleHelp,
}

const HERO_ICON: Readonly<Record<Tone, typeof ShieldCheck>> = {
  success: ShieldCheck,
  warning: ShieldAlert,
  danger: ShieldX,
  info: Info,
  neutral: CircleHelp,
}

const rowId = (validationId: string, checker: string): string => `sig-${validationId}-${checker}`

function ConfidenceRing({ value, tone }: { value: number; tone: Tone }) {
  const radius = 22
  const circumference = 2 * Math.PI * radius
  const level = confidenceLevel(value)
  return (
    <div
      className="relative h-14 w-14 shrink-0"
      role="img"
      aria-label={`Confiança ${level.label}: ${formatPercent(value)}`}
    >
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
        <circle cx="28" cy="28" r={radius} fill="none" strokeWidth="5" className="stroke-black/10" />
        <circle
          cx="28"
          cy="28"
          r={radius}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, value)))}
          className={TONES[tone].stroke}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[13px] font-bold tabular-nums">
        {Math.round(value * 100)}
      </span>
    </div>
  )
}

function EvidenceBar({ counts }: { counts: StanceCounts }) {
  const total = counts.supports + counts.contradicts + counts.neutral + counts.unknown
  const segments: readonly { key: Stance; value: number; className: string }[] = [
    { key: 'supports', value: counts.supports, className: 'bg-emerald-500' },
    { key: 'neutral', value: counts.neutral, className: 'bg-amber-400' },
    { key: 'contradicts', value: counts.contradicts, className: 'bg-red-500' },
    { key: 'unknown', value: counts.unknown, className: 'bg-zinc-300' },
  ]
  return (
    <div>
      <div
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={segments.map((s) => `${s.value} ${STANCES[s.key].label.toLowerCase()}`).join(', ')}
      >
        {total === 0 ? (
          <div className="h-full w-full bg-muted" />
        ) : (
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div key={s.key} className={cn('h-full', s.className)} style={{ flexGrow: s.value }} />
            ))
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full', s.className)} aria-hidden />
            <span className="font-mono font-semibold tabular-nums text-foreground">{s.value}</span>
            {STANCES[s.key].label.toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SignalItem({
  view,
  id,
  open,
  onToggle,
  now,
}: {
  view: SignalView
  id: string
  open: boolean
  onToggle: () => void
  now: Date
}) {
  const stance = STANCES[view.stance]
  const tone = TONES[stance.tone]
  const Icon = STANCE_ICON[view.stance]
  const { signal } = view
  const observed = new Date(signal.observed_at)
  return (
    <li id={id} className="scroll-mt-24">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        className="group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone.icon)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-foreground">{view.label}</span>
            <span className={cn('text-[11px] font-medium', tone.icon)}>{stance.label}</span>
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{view.summary}</span>
        </span>
        <span
          className="mt-1 hidden w-24 shrink-0 sm:block"
          title={`Força ${formatPercent(signal.strength)} × confiança ${formatPercent(signal.confidence)}`}
        >
          <span className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>peso</span>
            <span className="font-mono tabular-nums">{formatPercent(view.impact)}</span>
          </span>
          <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn('block h-full rounded-full', tone.fill)}
              style={{ width: `${view.impact * 100}%` }}
            />
          </span>
        </span>
        <ChevronDown
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={`${id}-panel`}
          className="mb-1 ml-10 mr-3 space-y-3 rounded-lg bg-muted/40 p-3 animate-fade-in"
        >
          {view.facts.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {view.facts.map((fact) => (
                <div key={fact.label} className="contents">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="break-words font-mono text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">Sem detalhes adicionais para esta verificação.</p>
          )}
          <p className="border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            Fonte <span className="font-mono">{signal.source}</span> · v{signal.checker_version} · força{' '}
            {formatPercent(signal.strength)} × confiança {formatPercent(signal.confidence)} · observado{' '}
            {formatRelative(observed, now)} · válido por {formatTtl(signal.ttl_seconds)}
          </p>
        </div>
      )}
    </li>
  )
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1500)
          })
          .catch(() => undefined)
      }}
    >
      {done ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {done ? 'Copiado' : label}
    </Button>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  )
}

export function ValidationResult({
  validation,
  defaultCollapsed = false,
  defaultExpanded = false,
}: {
  validation: ValidationDto
  /** Começa só com o cabeçalho visível (útil para resultados antigos no histórico). */
  defaultCollapsed?: boolean
  /** Começa com todas as evidências abertas. */
  defaultExpanded?: boolean
}) {
  const [now] = useState(() => new Date())
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpanded ? validation.signals.map((s) => s.checker) : []),
  )

  const verdict = VERDICTS[validation.verdict ?? 'INSUFFICIENT_EVIDENCE'] ?? FALLBACK_VERDICT
  const tone = TONES[verdict.tone]
  const HeroIcon = HERO_ICON[verdict.tone]
  const confidence = validation.confidence ?? 0
  const level = confidenceLevel(confidence)
  const score = validation.score ?? 0

  const views = useMemo(
    () => validation.signals.map((s) => describeSignal(s, now)),
    [validation.signals, now],
  )
  const counts = useMemo(() => countStances(views), [views])
  const groups = useMemo(() => groupViews(views), [views])
  const snapshot = useMemo(() => buildSnapshot(views, now), [views, now])
  const attention = views.filter((v) => v.attention !== null)

  const registryMissing =
    validation.address_unavailable_reason === 'cnpj_not_in_snapshot' ||
    validation.signals.some(
      (s) => s.checker === 'registry_status' && s.detail['reason'] === 'not_in_registry',
    )
  const partial = validation.status !== 'completed'
  const message = validation.explanation_detail?.message ?? validation.explanation ?? verdict.description
  const allOpen = openIds.size === views.length && views.length > 0

  const toggle = (checker: string): void =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(checker)) next.delete(checker)
      else next.add(checker)
      return next
    })

  const reveal = (checker: string): void => {
    setOpenIds((prev) => new Set(prev).add(checker))
    window.setTimeout(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      document
        .getElementById(rowId(validation.validation_id, checker))
        ?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    }, 0)
  }

  const created = new Date(validation.created_at)
  const shortId = validation.validation_id.slice(0, 8)

  return (
    <Card className="animate-fade-in overflow-hidden">
      <header className={cn('flex flex-wrap items-center gap-x-5 gap-y-3 border-b px-6 py-5', tone.hero)}>
        <div
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/70 ring-1 ring-black/5',
            tone.icon,
          )}
        >
          <HeroIcon className="h-6 w-6" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cn('text-lg font-semibold leading-tight tracking-tight', tone.text)}>
              {verdict.label}
            </h3>
            {validation.claim && (
              <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-black/5">
                {CLAIM_LABELS[validation.claim.type] ?? validation.claim.type}
              </span>
            )}
            {partial && (
              <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-black/5">
                resultado parcial
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-snug text-foreground/70">{message}</p>
        </div>
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-3">
            <ConfidenceRing value={confidence} tone={verdict.tone} />
            <div className="leading-tight">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Confiança
              </p>
              <p className={cn('text-sm font-semibold capitalize', tone.text)}>{level.label}</p>
            </div>
          </div>
          <div
            className="border-l border-black/10 pl-5 leading-tight"
            title="Resultado ponderado das evidências, de −1 (contra) a +1 (a favor)"
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Score</p>
            <p className="font-mono text-lg font-bold tabular-nums">
              {score > 0 ? '+' : ''}
              {score.toFixed(2)}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expandir resultado' : 'Recolher resultado'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', !collapsed && 'rotate-180')}
              aria-hidden
            />
          </Button>
        </div>
      </header>

      {!collapsed && (
        <>
          {(registryMissing || partial) && (
            <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50/60 px-6 py-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
              <p>
                {registryMissing
                  ? 'Este CNPJ não está na competência carregada da Receita. As verificações que dependem do cadastro ficam sem dados até a próxima carga.'
                  : 'O enriquecimento ainda pode alterar este veredito.'}
              </p>
            </div>
          )}

          <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-7 bg-card p-6">
              <Section title="Resumo das evidências">
                <EvidenceBar counts={counts} />
              </Section>

              <Section title={`Pontos de atenção${attention.length > 0 ? ` (${attention.length})` : ''}`}>
                {attention.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                    Nenhuma evidência contrária ou ponto a verificar.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {attention.map((view) => {
                      const danger = view.stance === 'contradicts'
                      return (
                        <li key={view.checker}>
                          <button
                            type="button"
                            onClick={() => reveal(view.checker)}
                            className={cn(
                              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              danger
                                ? 'border-red-200 bg-red-50 text-red-900 hover:bg-red-100/70'
                                : 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100/70',
                            )}
                          >
                            <AlertTriangle
                              className={cn(
                                'mt-0.5 h-4 w-4 shrink-0',
                                danger ? 'text-red-600' : 'text-amber-600',
                              )}
                              aria-hidden
                            />
                            <span className="flex-1">
                              <span className="font-medium">{view.label}.</span> {view.attention}
                            </span>
                            <span className="shrink-0 text-[11px] underline-offset-2 hover:underline">
                              ver evidência
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </Section>

              <Section
                title="Evidências por categoria"
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={() => setOpenIds(allOpen ? new Set() : new Set(views.map((v) => v.checker)))}
                  >
                    <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />
                    {allOpen ? 'Recolher tudo' : 'Expandir tudo'}
                  </Button>
                }
              >
                <div className="space-y-5">
                  {groups.map((group) => {
                    const supports = group.views.filter((v) => v.stance === 'supports').length
                    return (
                      <div key={group.id} role="group" aria-label={group.title}>
                        <div className="mb-1 flex items-center justify-between px-3">
                          <h5 className="text-[13px] font-semibold text-foreground">{group.title}</h5>
                          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="flex gap-1" aria-hidden>
                              {group.views.map((v) => (
                                <span
                                  key={v.checker}
                                  className={cn(
                                    'h-1.5 w-1.5 rounded-full',
                                    TONES[STANCES[v.stance].tone].fill,
                                  )}
                                />
                              ))}
                            </span>
                            {supports} de {group.views.length} a favor
                          </span>
                        </div>
                        <ul className="divide-y divide-border/50">
                          {group.views.map((view) => (
                            <SignalItem
                              key={view.checker}
                              view={view}
                              id={rowId(validation.validation_id, view.checker)}
                              open={openIds.has(view.checker)}
                              onToggle={() => toggle(view.checker)}
                              now={now}
                            />
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              </Section>
            </div>

            <aside className="space-y-7 bg-card p-6">
              <Section title="Resumo do cadastro">
                <dl className="space-y-3">
                  {snapshot.map((item) => (
                    <div key={item.label}>
                      <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
                      <dd
                        className={cn(
                          'mt-0.5 flex items-start gap-1.5 text-[13px] font-medium leading-snug',
                          item.value === null ? 'text-muted-foreground/60' : 'text-foreground',
                        )}
                      >
                        {item.value !== null && item.tone === 'warn' && (
                          <AlertTriangle
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
                            aria-label="Atenção"
                          />
                        )}
                        {item.value ?? 'Sem dados'}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Section>

              <Section title="Sobre esta avaliação">
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Criada</dt>
                    <dd className="text-right" title={created.toLocaleString('pt-BR')}>
                      {formatRelative(created, now)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Expira em</dt>
                    <dd className="text-right">{formatDate(validation.expires_at)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Política</dt>
                    <dd className="font-mono">{validation.policy_version ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Local</dt>
                    <dd>
                      {validation.address
                        ? `${validation.address.uf ?? '—'}${validation.address.geo_precision === 'NONE' ? ' · sem coordenadas' : ` · ${validation.address.geo_precision.toLowerCase()}`}`
                        : 'endereço não resolvido'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">ID</dt>
                    <dd className="font-mono" title={validation.validation_id}>
                      {shortId}
                    </dd>
                  </div>
                </dl>
                <div className="-ml-2 flex flex-wrap gap-1">
                  <CopyButton label="Copiar ID" value={validation.validation_id} />
                  <CopyButton label="Copiar JSON" value={JSON.stringify(validation, null, 2)} />
                </div>
              </Section>
            </aside>
          </div>
        </>
      )}
    </Card>
  )
}
