import { FileJson } from 'lucide-react'
import { Badge } from '@/components/ui'
import { JsonViewer } from './JsonViewer'
import { LEVEL_META, type TraceEntry, type TraceExpansion } from './meta'

const initialExpansion = (mode: TraceExpansion): 'auto' | 'expanded' | 'collapsed' => {
  if (mode === 'all') return 'expanded'
  if (mode === 'none') return 'collapsed'
  return 'auto'
}

export function TraceStepDetail({
  entry,
  total,
  expansion,
  expansionVersion = 0,
  panelId = 'trace-detail',
}: {
  readonly entry: TraceEntry
  readonly total: number
  readonly expansion: TraceExpansion
  readonly expansionVersion?: number
  readonly panelId?: string
}) {
  const meta = LEVEL_META[entry.event.level]
  const Icon = meta.icon

  return (
    <section
      id={panelId}
      data-testid={panelId}
      role="tabpanel"
      aria-labelledby={`trace-step-${entry.index}`}
      tabIndex={0}
      className="min-w-0 animate-fade-in p-5 motion-reduce:animate-none"
    >
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={meta.badge} className="text-[13px] font-medium">
            <Icon className="mr-1 h-3.5 w-3.5" aria-hidden />
            {meta.label}
          </Badge>
          <span className="text-[13px] text-foreground/70">
            Passo {entry.index + 1} de {total}
          </span>
        </div>

        <h3 className="break-all font-mono text-base font-semibold leading-snug text-foreground">
          {entry.event.code}
        </h3>

        <p className="text-[15px] leading-relaxed text-foreground">{entry.event.message}</p>
      </header>

      <div className="mt-4">
        {entry.event.details === undefined ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-foreground/70">
            <FileJson className="h-4 w-4 shrink-0 text-foreground/50" aria-hidden />
            Este passo não registrou payload de detalhes.
          </div>
        ) : (
          <JsonViewer
            key={`${entry.index}:${expansion}:${expansionVersion}`}
            value={entry.event.details}
            initialExpansion={initialExpansion(expansion)}
          />
        )}
      </div>
    </section>
  )
}
