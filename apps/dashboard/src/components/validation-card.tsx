import type { ValidationSignal, ValidationDto } from '@/api/client'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui'
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  CircleMinus,
  XCircle,
} from 'lucide-react'

const CHECKER_META: Record<string, { label: string; description: string }> = {
  document_integrity: {
    label: 'Integridade do documento',
    description: 'Validação de dígitos verificadores',
  },
  registry_status: { label: 'Situação cadastral', description: 'Cadastro na Receita Federal' },
  country_check: { label: 'País / UF', description: 'Localização geográfica' },
  cep_consistency: { label: 'Consistência do CEP', description: 'CEP ↔ UF ↔ município' },
  cnefe_match: { label: 'CNEFE (IBGE)', description: 'Endereço no censo' },
  cotenancy: { label: 'Co-tenância', description: 'CNPJs no mesmo imóvel' },
  cnae_vs_location: { label: 'CNAE × Local', description: 'Compatibilidade atividade/local' },
  geocode_consensus: { label: 'Geocoding', description: 'Consenso entre provedores' },
  places_match: { label: 'POIs próximos', description: 'Estabelecimentos no raio' },
  digital_footprint: { label: 'Pegada digital', description: 'DDD, domínio de e-mail' },
  street_view_vlm: { label: 'Fachada (VLM)', description: 'Análise visual da fachada' },
  partner_graph: { label: 'Grafo de sócios', description: 'Padrões de fachada' },
}

const STANCE_META: Record<
  string,
  { icon: React.ReactNode; color: string; bg: string; text: string; label: string }
> = {
  supports: {
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 border-emerald-200',
    text: 'text-emerald-800',
    label: 'A favor',
  },
  contradicts: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    color: 'text-red-600',
    bg: 'bg-red-50 border-red-200',
    text: 'text-red-800',
    label: 'Contra',
  },
  neutral: {
    icon: <CircleMinus className="h-3.5 w-3.5" />,
    color: 'text-amber-600',
    bg: 'bg-amber-50 border-amber-200',
    text: 'text-amber-800',
    label: 'Neutro',
  },
  unknown: {
    icon: <CircleHelp className="h-3.5 w-3.5" />,
    color: 'text-zinc-400',
    bg: 'bg-zinc-50 border-zinc-200',
    text: 'text-zinc-600',
    label: 'Sem dados',
  },
}

const VERDICT_META: Record<string, { color: string; bg: string; text: string; description: string }> = {
  CONFIRMED_COMMERCIAL: {
    color: 'bg-emerald-500',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    description: 'Endereço compatível com atividade comercial',
  },
  SHARED_VIRTUAL: {
    color: 'bg-amber-500',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    description: 'Endereço compartilhado (escritório/coworking)',
  },
  OCCUPIED_BY_OTHER_ENTITY: {
    color: 'bg-red-500',
    bg: 'bg-red-50',
    text: 'text-red-700',
    description: 'Outro estabelecimento ativo no mesmo imóvel',
  },
  RESIDENTIAL: {
    color: 'bg-blue-500',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    description: 'Endereço aparenta ser residência comum',
  },
  NOT_FOUND: {
    color: 'bg-red-500',
    bg: 'bg-red-50',
    text: 'text-red-700',
    description: 'Endereço não confirmável',
  },
  FOREIGN: {
    color: 'bg-blue-500',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    description: 'Endereço fora do Brasil',
  },
  INCONSISTENT: {
    color: 'bg-red-500',
    bg: 'bg-red-50',
    text: 'text-red-700',
    description: 'Sinais contraditórios — requer revisão',
  },
  INSUFFICIENT_EVIDENCE: {
    color: 'bg-zinc-400',
    bg: 'bg-zinc-50',
    text: 'text-zinc-600',
    description: 'Evidência insuficiente para conclusão',
  },
}

const DETAIL_LABELS: Record<string, string> = {
  situacao: 'Situação',
  data_abertura: 'Abertura',
  country: 'País',
  uf: 'UF',
  cep: 'CEP',
  localidade: 'Localidade',
  match: 'Match',
  cnefe_id: 'CNEFE ID',
  especie: 'Espécie',
  residential_hint: 'Residencial',
  active_cnpj_count: 'CNPJs ativos',
  distinct_cnae_div: 'Divisões CNAE',
  other_active_cnpjs: 'Outros CNPJs',
  other_names: 'Nomes',
  same_unit: 'Mesma unidade',
  shared_kind: 'Tipo',
  divisao: 'Divisão',
  categoria: 'Categoria',
  reason: 'Motivo',
  dispersion_m: 'Dispersão (m)',
  precision: 'Precisão',
  matched_poi: 'POI',
  nearby_pois: 'POIs',
  ddd: 'DDD',
  expected_ufs: 'UFs esperadas',
  facade: 'Fachada',
  image_date: 'Data da imagem',
  other_business_name: 'Outro negócio',
  pattern: 'Padrão',
  cnpjs_sharing_partner: 'Sócio em comum',
  recent_openings_at_address: 'Aberturas recentes',
  co_located_cnpjs: 'Co-localizados',
  timeout_ms: 'Timeout (ms)',
}

function DetailChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </span>
  )
}

function SignalRow({ signal }: { signal: ValidationSignal }) {
  const meta = CHECKER_META[signal.checker] ?? { label: signal.checker, description: '' }
  const stance = STANCE_META[signal.stance] ?? STANCE_META.unknown!

  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={cn('shrink-0', stance.color)}>{stance.icon}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{meta.label}</span>
            <span className={cn('shrink-0 text-[11px] font-medium', stance.color)}>{stance.label}</span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">{meta.description}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:w-48">
        <div className="flex-1">
          <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>força</span>
            <span className="font-mono">{(signal.strength * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', stance.bg.split(' ')[0])}
              style={{ width: `${signal.strength * 100}%` }}
            />
          </div>
        </div>
        <div className="flex-1">
          <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>conf</span>
            <span className="font-mono">{(signal.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/40 transition-all"
              style={{ width: `${signal.confidence * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 sm:w-56">
        {Object.entries(signal.detail)
          .filter(([key]) => key !== 'verdict_hint')
          .slice(0, 4)
          .map(([key, value]) => (
            <DetailChip
              key={key}
              label={DETAIL_LABELS[key] ?? key}
              value={
                value === null || value === undefined
                  ? '—'
                  : typeof value === 'boolean'
                    ? value
                      ? 'sim'
                      : 'não'
                    : Array.isArray(value)
                      ? value.slice(0, 2).join(', ')
                      : String(value).slice(0, 20)
              }
            />
          ))}
      </div>
    </div>
  )
}

export function ValidationCard({ validation }: { validation: ValidationDto }) {
  const verdict = validation.verdict ?? 'INSUFFICIENT_EVIDENCE'
  const meta = VERDICT_META[verdict] ?? VERDICT_META.INSUFFICIENT_EVIDENCE!
  const confidence = validation.confidence ?? 0
  const score = validation.score ?? 0

  const supports = validation.signals.filter((s) => s.stance === 'supports').length
  const contradicts = validation.signals.filter((s) => s.stance === 'contradicts').length
  const unknown = validation.signals.filter((s) => s.stance === 'unknown').length

  return (
    <Card className="animate-fade-in overflow-hidden">
      <div className={cn('border-b px-6 py-4', meta.bg)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={cn('h-2.5 w-2.5 rounded-full', meta.color)} />
            <div>
              <h3 className={cn('text-base font-semibold', meta.text)}>
                {verdict.replace(/_/g, ' ').toLowerCase()}
              </h3>
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-right">
              <p className="font-mono text-lg font-bold tabular-nums text-foreground">
                {(confidence * 100).toFixed(0)}%
              </p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">confiança</p>
            </div>
            <div className="h-10 w-px bg-border" />
            <div className="text-right">
              <p className="font-mono text-lg font-bold tabular-nums text-foreground">
                {score > 0 ? '+' : ''}
                {score.toFixed(2)}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">score</p>
            </div>
          </div>
        </div>
      </div>

      <CardContent className="p-0">
        <div className="flex items-center gap-4 border-b border-border/60 bg-muted/30 px-6 py-2 text-xs">
          <span className="flex items-center gap-1 text-emerald-600">
            <ArrowUpRight className="h-3 w-3" />
            {supports} a favor
          </span>
          <span className="flex items-center gap-1 text-red-600">
            <ArrowDownRight className="h-3 w-3" />
            {contradicts} contra
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <ArrowRight className="h-3 w-3" />
            {unknown} sem dados
          </span>
          {validation.address && (
            <>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {validation.address.uf} · {validation.address.geo_precision}
              </span>
            </>
          )}
        </div>

        <div className="divide-y divide-border/40 px-6">
          {validation.signals.map((signal) => (
            <SignalRow key={signal.checker} signal={signal} />
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 bg-muted/30 px-6 py-2.5 text-[11px] text-muted-foreground">
          <span>
            <span className="font-medium">{validation.explanation}</span>
          </span>
          <span className="font-mono">
            {new Date(validation.created_at).toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
