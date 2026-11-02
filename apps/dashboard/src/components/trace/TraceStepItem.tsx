import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { LEVEL_META, type TraceEntry } from './meta'

export function TraceStepItem({
  entry,
  position,
  total,
  selected,
  isLast,
  onSelect,
}: {
  readonly entry: TraceEntry
  readonly position: number
  readonly total: number
  readonly selected: boolean
  readonly isLast: boolean
  readonly onSelect: () => void
}) {
  const meta = LEVEL_META[entry.event.level]
  const Icon = meta.icon

  return (
    <li role="none" className="relative">
      <span
        aria-hidden
        className={cn(
          'absolute left-[26px] top-0 z-10 w-px -translate-x-1/2 bg-border',
          isLast ? 'h-7' : 'h-full',
        )}
      />
      <button
        type="button"
        role="tab"
        id={`trace-step-${entry.index}`}
        aria-selected={selected}
        aria-controls="trace-detail"
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        className={cn(
          'relative flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
          selected ? 'bg-muted' : 'hover:bg-muted/60',
        )}
      >
        <span
          data-testid="trace-step-icon"
          className={cn(
            'relative z-20 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-card',
            selected ? 'border-border' : 'border-transparent',
          )}
        >
          <Icon className={cn('h-4 w-4', meta.iconClass)} aria-hidden />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all font-mono text-[15px] font-semibold leading-snug text-foreground">
              {entry.event.code}
            </span>
            <Badge variant={meta.badge} className="text-[13px] font-medium">
              {meta.label}
            </Badge>
          </span>
          <span className="mt-1 block truncate text-sm text-foreground/80">{entry.event.message}</span>
          <span className="mt-1 block text-[13px] text-foreground/60">
            Passo {position} de {total}
          </span>
        </span>

        <span
          className="ml-2 shrink-0 pt-0.5 font-mono text-[13px] tabular-nums text-foreground/50"
          aria-hidden
        >
          #{position}
        </span>
      </button>
    </li>
  )
}
