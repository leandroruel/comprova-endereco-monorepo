import type { ReactNode } from 'react'
import { Fragment } from 'react'
import { TraceStepItem } from './TraceStepItem'
import type { TraceEntry } from './meta'

export function TraceTimeline({
  entries,
  selectedIndex,
  total,
  onSelect,
  mobileDetail,
}: {
  readonly entries: readonly TraceEntry[]
  readonly selectedIndex: number | null
  readonly total: number
  readonly onSelect: (index: number) => void
  readonly mobileDetail?: ReactNode
}) {
  return (
    <div className="p-2">
      <ol role="tablist" aria-orientation="vertical" aria-label="Passos do trace" className="relative">
        {entries.map((entry, position) => (
          <Fragment key={entry.index}>
            <TraceStepItem
              entry={entry}
              position={entry.index + 1}
              total={total}
              selected={selectedIndex === entry.index}
              isLast={position === entries.length - 1}
              onSelect={() => onSelect(entry.index)}
            />
            {selectedIndex === entry.index && mobileDetail !== undefined && (
              <li role="none" className="border-t border-border lg:hidden">
                {mobileDetail}
              </li>
            )}
          </Fragment>
        ))}
      </ol>
    </div>
  )
}
