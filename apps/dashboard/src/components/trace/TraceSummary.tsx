import { Clock, ListTree } from 'lucide-react'
import type { DebugTraceEventDto } from '@/api/client'
import { cn } from '@/lib/utils'
import { LEVELS, LEVEL_META, countByLevel, formatDuration } from './meta'

export function TraceSummary({
  events,
  elapsedMs,
}: {
  readonly events: readonly DebugTraceEventDto[]
  readonly elapsedMs?: number
}) {
  const counts = countByLevel(events)
  const duration = formatDuration(elapsedMs)
  const summaryLabel = [
    `${events.length} ${events.length === 1 ? 'passo' : 'passos'}`,
    ...LEVELS.filter((level) => counts[level] > 0).map(
      (level) => `${counts[level]} ${LEVEL_META[level].label.toLowerCase()}`,
    ),
    `tempo total ${duration ?? 'não informado'}`,
  ].join(', ')

  return (
    <div
      data-testid="trace-summary"
      role="group"
      aria-label={summaryLabel}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-foreground/70"
    >
      <span className="inline-flex items-center gap-1.5">
        <ListTree className="h-4 w-4 text-foreground/60" aria-hidden />
        <strong className="font-semibold text-foreground">{events.length}</strong>{' '}
        {events.length === 1 ? 'passo' : 'passos'}{' '}
      </span>

      {LEVELS.map((level) => {
        const meta = LEVEL_META[level]
        const Icon = meta.icon
        return (
          <span key={level} className="inline-flex items-center gap-1.5">
            <Icon className={cn('h-4 w-4', meta.iconClass)} aria-hidden />
            <strong className="font-semibold text-foreground">{counts[level]}</strong>{' '}
            {meta.label.toLowerCase()}{' '}
          </span>
        )
      })}

      <span
        className="inline-flex items-center gap-1.5"
        title={
          duration === null
            ? 'O trace não inclui timestamps por passo; o tempo total é o da requisição de análise.'
            : 'Tempo total da requisição de análise.'
        }
      >
        <Clock className="h-4 w-4 text-foreground/60" aria-hidden />
        Tempo total: <strong className="font-semibold text-foreground">{duration ?? '—'}</strong>
      </span>
    </div>
  )
}
