import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Activity, Search } from 'lucide-react'
import type { DebugTraceEventDto } from '@/api/client'
import { Button, Card, CardTitle } from '@/components/ui'
import { TraceFilters } from './TraceFilters'
import { TraceStepDetail } from './TraceStepDetail'
import { TraceSummary } from './TraceSummary'
import { TraceTimeline } from './TraceTimeline'
import {
  copyText,
  countByLevel,
  eventToJson,
  matchesQuery,
  traceToJson,
  type TraceEntry,
  type TraceExpansion,
  type TraceLevel,
} from './meta'

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

export function TraceSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Carregando trace de execução">
      <div className="border-b border-border p-5">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-foreground/60" aria-hidden />
          <span className="text-base font-semibold text-foreground">Trace de execução</span>
        </div>
        <div className="mt-3 h-4 w-72 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
        <div className="space-y-2 border-b border-border p-3 lg:border-b-0 lg:border-r">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="flex items-start gap-3 px-3 py-3">
              <span className="mt-0.5 h-7 w-7 shrink-0 animate-pulse rounded-full bg-muted" />
              <span className="flex-1 space-y-2">
                <span className="block h-4 w-2/3 animate-pulse rounded bg-muted" />
                <span className="block h-3 w-full animate-pulse rounded bg-muted" />
              </span>
            </div>
          ))}
        </div>
        <div className="hidden space-y-3 p-5 lg:block">
          <span className="block h-4 w-24 animate-pulse rounded bg-muted" />
          <span className="block h-5 w-1/3 animate-pulse rounded bg-muted" />
          <span className="block h-24 w-full animate-pulse rounded bg-muted" />
          <span className="block h-40 w-full animate-pulse rounded bg-muted" />
        </div>
      </div>
    </Card>
  )
}

export interface ExecutionTraceProps {
  readonly events: readonly DebugTraceEventDto[]
  readonly loading?: boolean
  readonly elapsedMs?: number
}

export function ExecutionTrace({ events, loading = false, elapsedMs }: ExecutionTraceProps) {
  const [query, setQuery] = useState('')
  const [activeLevels, setActiveLevels] = useState<ReadonlySet<TraceLevel>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const [expansion, setExpansion] = useState<TraceExpansion>('auto')
  const [expansionVersion, setExpansionVersion] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [announcement, setAnnouncement] = useState('')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const entries = useMemo<TraceEntry[]>(() => events.map((event, index) => ({ event, index })), [events])
  const counts = useMemo(() => countByLevel(events), [events])
  const filtered = useMemo(
    () =>
      entries.filter(
        ({ event }) =>
          (activeLevels.size === 0 || activeLevels.has(event.level)) && matchesQuery(event, query),
      ),
    [entries, activeLevels, query],
  )

  const activeIndex = filtered.some((entry) => entry.index === selected)
    ? selected
    : (filtered[0]?.index ?? null)
  const activeEntry = filtered.find((entry) => entry.index === activeIndex) ?? null

  const toggleLevel = (level: TraceLevel): void => {
    setActiveLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const clearFilters = (): void => {
    setActiveLevels(new Set())
    setQuery('')
  }

  const moveSelection = (delta: number): void => {
    if (filtered.length === 0) return
    const currentPosition = filtered.findIndex((entry) => entry.index === activeIndex)
    const nextPosition = Math.min(Math.max(currentPosition + delta, 0), filtered.length - 1)
    const next = filtered[nextPosition]
    if (next === undefined) return
    setSelected(next.index)
    requestAnimationFrame(() => {
      document.getElementById(`trace-step-${next.index}`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  const copySelected = async (): Promise<void> => {
    if (activeEntry === null || activeIndex === null) return
    const ok = await copyText(eventToJson(activeEntry.event))
    setAnnouncement(ok ? `JSON do passo ${activeIndex + 1} copiado.` : 'Não foi possível copiar o JSON.')
  }

  const handleCopyTrace = async (): Promise<void> => {
    const ok = await copyText(traceToJson(events))
    setCopyState(ok ? 'copied' : 'failed')
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1600)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

    switch (event.key) {
      case 'ArrowDown':
      case 'j':
      case 'J':
        event.preventDefault()
        moveSelection(1)
        break
      case 'ArrowUp':
      case 'k':
      case 'K':
        event.preventDefault()
        moveSelection(-1)
        break
      case 'Enter':
        event.preventDefault()
        setExpansion((current) => (current === 'all' ? 'none' : 'all'))
        break
      case 'c':
      case 'C':
        event.preventDefault()
        void copySelected()
        break
      default:
        break
    }
  }

  if (loading) return <TraceSkeleton />

  const header = (
    <div className="z-20 rounded-t-xl border-b border-border bg-card px-5 pb-4 pt-4 lg:sticky lg:top-14">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-foreground/70" aria-hidden />
            Trace de execução
          </CardTitle>
          <p className="mt-1 hidden text-[13px] text-foreground/70 sm:block">
            Clique em um passo para inspecionar. Atalhos: <kbd>↑</kbd>/<kbd>↓</kbd> ou <kbd>j</kbd>/
            <kbd>k</kbd> navegam, <kbd>Enter</kbd> expande e <kbd>c</kbd> copia o JSON.
          </p>
        </div>
      </div>

      {events.length > 0 && (
        <>
          <div className="mt-2.5 sm:mt-3">
            <TraceSummary events={events} elapsedMs={elapsedMs} />
          </div>
          <div className="mt-2.5 sm:mt-3">
            <TraceFilters
              query={query}
              onQueryChange={setQuery}
              activeLevels={activeLevels}
              onToggleLevel={toggleLevel}
              onClearLevels={clearFilters}
              counts={counts}
              visibleCount={filtered.length}
              totalCount={entries.length}
              onExpandAll={() => {
                setExpansion('all')
                setExpansionVersion((current) => current + 1)
              }}
              onCollapseAll={() => {
                setExpansion('none')
                setExpansionVersion((current) => current + 1)
              }}
              onCopyTrace={() => void handleCopyTrace()}
              copyState={copyState}
            />
          </div>
        </>
      )}
    </div>
  )

  if (events.length === 0) {
    return (
      <Card>
        {header}
        <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
          <Search className="mb-3 h-8 w-8 text-foreground/30" aria-hidden />
          <p className="text-[15px] font-medium text-foreground">Nenhum evento registrado</p>
          <p className="mt-1 text-sm text-foreground/70">
            Envie um documento para acompanhar cada passo do pipeline.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card onKeyDown={handleKeyDown} aria-keyshortcuts="ArrowUp ArrowDown j k Enter c" className="relative">
      {header}

      <p className="sr-only" role="status">
        {announcement}
      </p>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
          <Search className="mb-3 h-8 w-8 text-foreground/30" aria-hidden />
          <p className="text-[15px] font-medium text-foreground">Nenhum passo corresponde aos filtros</p>
          <p className="mt-1 text-sm text-foreground/70">Ajuste a busca ou os status selecionados.</p>
          <Button type="button" variant="outline" size="sm" onClick={clearFilters} className="mt-4">
            Limpar filtros
          </Button>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
          <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
            <TraceTimeline
              entries={filtered}
              selectedIndex={activeIndex}
              total={entries.length}
              onSelect={setSelected}
              mobileDetail={
                activeEntry === null ? undefined : (
                  <TraceStepDetail
                    entry={activeEntry}
                    total={entries.length}
                    expansion={expansion}
                    expansionVersion={expansionVersion}
                    panelId="trace-detail-mobile"
                  />
                )
              }
            />
          </div>

          <div className="hidden min-w-0 lg:block">
            {activeEntry !== null && (
              <TraceStepDetail
                entry={activeEntry}
                total={entries.length}
                expansion={expansion}
                expansionVersion={expansionVersion}
              />
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
