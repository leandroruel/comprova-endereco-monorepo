import { Check, Copy, Expand, Search, Shrink, X } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { LEVELS, LEVEL_META, type TraceLevel } from './meta'

export function TraceFilters({
  query,
  onQueryChange,
  activeLevels,
  onToggleLevel,
  onClearLevels,
  counts,
  visibleCount,
  totalCount,
  onExpandAll,
  onCollapseAll,
  onCopyTrace,
  copyState,
}: {
  readonly query: string
  readonly onQueryChange: (value: string) => void
  readonly activeLevels: ReadonlySet<TraceLevel>
  readonly onToggleLevel: (level: TraceLevel) => void
  readonly onClearLevels: () => void
  readonly counts: Readonly<Record<TraceLevel, number>>
  readonly visibleCount: number
  readonly totalCount: number
  readonly onExpandAll: () => void
  readonly onCollapseAll: () => void
  readonly onCopyTrace: () => void
  readonly copyState: 'idle' | 'copied' | 'failed'
}) {
  const hasFilters = activeLevels.size > 0 || query.trim().length > 0

  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/50"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Buscar evento, mensagem ou JSON"
            aria-label="Buscar no trace"
            className="h-9 pl-9 pr-9 text-sm"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Limpar busca"
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por status">
          {LEVELS.map((level) => {
            const meta = LEVEL_META[level]
            const Icon = meta.icon
            const active = activeLevels.has(level)
            return (
              <button
                key={level}
                type="button"
                aria-pressed={active}
                onClick={() => onToggleLevel(level)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-foreground/25 bg-muted text-foreground'
                    : 'border-border bg-card text-foreground/70 hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <Icon className={cn('h-3.5 w-3.5', meta.iconClass)} aria-hidden />
                {meta.label}
                <span className="tabular-nums text-foreground/60">{counts[level]}</span>
              </button>
            )
          })}
          {hasFilters && (
            <button
              type="button"
              onClick={onClearLevels}
              className="rounded-full px-2 py-1 text-[13px] font-medium text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Limpar filtros
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[13px] tabular-nums text-foreground/70" aria-live="polite">
          {visibleCount} de {totalCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onExpandAll}
          className="text-[13px]"
          aria-label="Expandir tudo (seções do JSON do passo selecionado)"
        >
          <Expand className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Expandir tudo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCollapseAll}
          className="text-[13px]"
          aria-label="Recolher tudo (seções do JSON do passo selecionado)"
        >
          <Shrink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Recolher tudo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCopyTrace}
          aria-label="Copiar trace completo (JSON)"
          className="text-[13px]"
        >
          {copyState === 'copied' ? (
            <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-700" aria-hidden />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          {copyState === 'copied' ? 'Trace copiado' : copyState === 'failed' ? 'Falhou' : 'Copiar trace'}
        </Button>
      </div>
    </div>
  )
}
