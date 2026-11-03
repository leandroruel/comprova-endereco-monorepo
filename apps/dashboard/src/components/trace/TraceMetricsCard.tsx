'use client'

import React from 'react'
import { Clock, DollarSign, Play, Wrench } from 'lucide-react'
import type { DebugAnalysisDto, DebugTraceEventDto } from '@/api/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { formatDuration } from './meta'

export interface TraceMetricsCardProps {
  readonly events: readonly DebugTraceEventDto[]
  readonly elapsedMs?: number
  readonly provenance?: DebugAnalysisDto['provenance']
}

/**
 * Error boundary para evitar que falhas no card de métricas derrubem
 * todo o componente de debug. O trace é best-effort: nunca deve impedir
 * o usuário de ver o resultado da análise.
 */
class TraceMetricsErrorBoundary extends React.Component<
  { readonly children: React.ReactNode },
  { readonly hasError: boolean }
> {
  constructor(props: { readonly children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): { readonly hasError: boolean } {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

const STEP_KIND_COLORS: Readonly<Record<string, string>> = {
  'pdf.open': 'bg-slate-500/20 border-slate-500/40',
  'pdf.text': 'bg-blue-500/20 border-blue-500/40',
  'text.reference': 'bg-purple-500/20 border-purple-500/40',
  'fiscal.reference': 'bg-purple-500/20 border-purple-500/40',
  'text.local': 'bg-emerald-500/20 border-emerald-500/40',
  'text.marker': 'bg-indigo-500/20 border-indigo-500/40',
  'marker.call': 'bg-indigo-500/20 border-indigo-500/40',
  'marker.fallback': 'bg-amber-500/20 border-amber-500/40',
  'text.fallback': 'bg-amber-500/20 border-amber-500/40',
  'fields.merge': 'bg-cyan-500/20 border-cyan-500/40',
  'document.fields': 'bg-cyan-500/20 border-cyan-500/40',
  'analysis.result': 'bg-slate-500/20 border-slate-500/40',
} as const

const STEP_KIND_LABELS: Readonly<Record<string, string>> = {
  'pdf.open': 'Abrir PDF',
  'pdf.text': 'Extrair texto local',
  'text.reference': 'Referência (texto)',
  'fiscal.reference': 'Referência (QR Code)',
  'text.local': 'Camada local',
  'text.marker': 'Chamar Marker',
  'marker.call': 'Inferência Marker',
  'marker.fallback': 'Fallback Marker',
  'text.fallback': 'Fallback local',
  'fields.merge': 'Combinar campos',
  'document.fields': 'Extração de campos',
  'analysis.result': 'Resultado',
} as const

const stepOrder = new Map(Object.keys(STEP_KIND_LABELS).map((code, index) => [code, index]))

function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  return s >= 10 ? `${Math.round(s)} ms` : `${s.toFixed(1)} ms`
}

function computeStepTimes(
  events: readonly DebugTraceEventDto[],
  elapsedMs: number | undefined,
  markerProcessingMs: number | undefined,
): {
  readonly code: string
  readonly label: string
  readonly durationMs: number | null
}[] {
  const total = elapsedMs ?? 0
  const markerTime = markerProcessingMs ?? 0
  const localTime = Math.max(0, total - markerTime)

  const occurred = events
    .map((event) => ({
      code: event.code,
      label: STEP_KIND_LABELS[event.code] ?? event.code,
    }))
    .filter((step, index, arr) => arr.findIndex((s) => s.code === step.code) === index)
    .sort((a, b) => (stepOrder.get(a.code) ?? 999) - (stepOrder.get(b.code) ?? 999))

  if (occurred.length === 0) return []

  const markerIndex = occurred.findIndex((s) => s.code === 'marker.call' || s.code === 'text.marker')
  const nonMarkerCount = occurred.length - (markerIndex >= 0 ? 1 : 0)

  return occurred.map((step) => {
    if (markerIndex >= 0 && step.code === occurred[markerIndex]?.code) {
      return {
        code: step.code,
        label: step.label,
        durationMs: markerTime > 0 ? markerTime : null,
      }
    }
    if (nonMarkerCount > 0 && localTime > 0) {
      return {
        code: step.code,
        label: step.label,
        durationMs: localTime / nonMarkerCount,
      }
    }
    return { code: step.code, label: step.label, durationMs: null }
  })
}

export function TraceMetricsCard({ events, elapsedMs, provenance }: TraceMetricsCardProps) {
  const totalDuration = formatDuration(elapsedMs)
  const markerMs = provenance?.processingTimeMs ?? null

  const stepTimes = computeStepTimes(events, elapsedMs, markerMs)

  const totalSteps = stepTimes.length
  const totalDurationNum = elapsedMs ?? 0

  return (
    <TraceMetricsErrorBoundary>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-foreground/60" aria-hidden />
            <CardTitle className="text-base">Trace de execução</CardTitle>
          </div>
          <div className="flex items-center gap-2 text-xs text-foreground/50">
            <Play className="h-3 w-3" aria-hidden />
            {totalSteps} etapa{totalSteps !== 1 ? 's' : ''}
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {/* Métricas resumo */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            <div className="border rounded-lg p-3 bg-muted/40">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-3.5 w-3.5 text-foreground/50" aria-hidden />
                <span className="text-[10px] uppercase tracking-wider text-foreground/40">Duração</span>
              </div>
              <div className="text-lg font-mono font-semibold text-foreground">{totalDuration ?? '—'}</div>
            </div>
            <div className="border rounded-lg p-3 bg-muted/40">
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="h-3.5 w-3.5 text-foreground/50" aria-hidden />
                <span className="text-[10px] uppercase tracking-wider text-foreground/40">Custo</span>
              </div>
              <div className="text-lg font-mono font-semibold text-foreground">$0,00</div>
            </div>
            <div className="border rounded-lg p-3 bg-muted/40">
              <div className="flex items-center gap-2 mb-1">
                <span className="h-3.5 w-3.5 rounded bg-foreground/10 text-foreground/50 flex items-center justify-center">
                  <span className="text-[10px] font-bold">T</span>
                </span>
                <span className="text-[10px] uppercase tracking-wider text-foreground/40">Tokens</span>
              </div>
              <div className="text-lg font-mono font-semibold text-foreground">—</div>
            </div>
            <div className="border rounded-lg p-3 bg-muted/40">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-foreground/40">Chamadas LLM</span>
              </div>
              <div className="text-lg font-mono font-semibold text-foreground">—</div>
            </div>
            <div className="border rounded-lg p-3 bg-muted/40">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-foreground/40">
                  Chamadas ferramenta
                </span>
              </div>
              <div className="text-lg font-mono font-semibold text-foreground">—</div>
            </div>
            <div className="border rounded-lg p-3 bg-muted/40">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-foreground/40">Erros</span>
              </div>
              <div className="text-lg font-mono font-semibold text-foreground">0</div>
            </div>
          </div>

          {/* Linha do tempo */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-foreground/40 mb-2">
              <span className="flex-1 shrink-0 truncate">Etapa</span>
              <span className="flex-1">Duração</span>
              <span className="text-right w-16 shrink-0">% do total</span>
            </div>
            {stepTimes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-foreground/50">
                Nenhuma etapa de tempo registrada no trace.
              </div>
            ) : (
              stepTimes.map((step) => {
                const pct =
                  step.durationMs !== null && totalDurationNum > 0
                    ? Math.round((step.durationMs / totalDurationNum) * 100)
                    : null
                const color = STEP_KIND_COLORS[step.code] ?? 'bg-slate-500/20 border-slate-500/40'
                return (
                  <div
                    key={`${step.code}-${step.label}`}
                    className="flex items-center gap-2 border border-border/50 rounded-lg p-2 bg-muted/30"
                  >
                    <span className="w-20 shrink-0 truncate text-[11px] font-medium text-foreground">
                      {step.label}
                    </span>
                    <span className="flex-1 min-w-0">
                      <div className="h-2 w-full rounded-full bg-border overflow-hidden">
                        <div
                          className="h-full"
                          style={{
                            width:
                              step.durationMs !== null
                                ? Math.min((step.durationMs / (totalDurationNum ?? 1)) * 100, 100)
                                : 0,
                          }}
                          className={color}
                        />
                      </div>
                      <div className="flex items-baseline gap-1 mt-1">
                        <span className="text-[11px] font-mono font-semibold text-foreground">
                          {fmtMs(step.durationMs)}
                        </span>
                        {pct !== null && <span className="text-[10px] text-foreground/40">({pct}%)</span>}
                      </div>
                    </span>
                    <span className="w-16 shrink-0 text-right text-[11px] font-mono text-foreground/50">
                      {pct !== null ? `${pct}%` : '—'}
                    </span>
                  </div>
                )
              })
            )}
          </div>

          {/* Legenda */}
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[10px] text-foreground/40">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-500/20 border-slate-500/40" aria-hidden />
              Carregamento
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500/20 border-blue-500/40" aria-hidden />
              Texto local
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500/20 border-indigo-500/40" aria-hidden />
              Marker
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500/20 border-amber-500/40" aria-hidden />
              Fallback
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-500/20 border-cyan-500/40" aria-hidden />
              Combinação
            </span>
          </div>
        </CardContent>
      </Card>
    </TraceMetricsErrorBoundary>
  )
}
