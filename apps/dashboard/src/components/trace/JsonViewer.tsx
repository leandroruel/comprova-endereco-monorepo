import { useRef, useState } from 'react'
import { Braces, Check, ChevronDown, ChevronRight, Copy, Expand, Shrink, WrapText } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { copyText } from './meta'

type JsonValue = unknown

const isContainer = (value: JsonValue): value is Record<string, JsonValue> | JsonValue[] =>
  typeof value === 'object' && value !== null

const entriesOf = (
  value: Record<string, JsonValue> | JsonValue[],
): ReadonlyArray<readonly [string, JsonValue]> =>
  Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)

const collectContainerPaths = (
  value: JsonValue,
  path = '$',
  depth = 0,
  paths: string[] = [],
  minDepth = 1,
): string[] => {
  if (!isContainer(value)) return paths
  // O nó raiz fica aberto no modo auto; os filhos containers entram recolhidos.
  if (depth >= minDepth) paths.push(path)
  for (const [key, child] of entriesOf(value)) {
    collectContainerPaths(child, `${path}.${key}`, depth + 1, paths, minDepth)
  }
  return paths
}

const primitiveText = (value: JsonValue): string => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? 'null'
}

const primitiveClass = (value: JsonValue): string => {
  if (typeof value === 'string') return 'text-emerald-700'
  if (value === null) return 'text-rose-700'
  if (typeof value === 'number') return 'text-amber-700'
  if (typeof value === 'boolean') return 'text-violet-700'
  return 'text-foreground/70'
}

type TokenKind = 'plain' | 'key' | 'string' | 'number' | 'boolean' | 'null'

interface JsonToken {
  readonly text: string
  readonly kind: TokenKind
}

const TOKEN_PATTERN =
  /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

const KIND_CLASS: Readonly<Record<TokenKind, string>> = {
  plain: 'text-foreground/80',
  key: 'text-sky-800',
  string: 'text-emerald-700',
  number: 'text-amber-700',
  boolean: 'text-violet-700',
  null: 'text-rose-700',
}

const classify = (token: string): TokenKind => {
  if (token.endsWith(':')) return 'key'
  if (token.startsWith('"')) return 'string'
  if (token === 'true' || token === 'false') return 'boolean'
  if (token === 'null') return 'null'
  return 'number'
}

/** Tokeniza uma linha de JSON sem dependência externa. */
const tokenizeLine = (line: string): JsonToken[] => {
  const tokens: JsonToken[] = []
  let cursor = 0
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ text: line.slice(cursor, index), kind: 'plain' })
    tokens.push({ text: match[0], kind: classify(match[0]) })
    cursor = index + match[0].length
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: 'plain' })
  return tokens
}

function JsonNode({
  label,
  value,
  path,
  depth,
  collapsed,
  onToggle,
}: {
  readonly label: string | null
  readonly value: JsonValue
  readonly path: string
  readonly depth: number
  readonly collapsed: ReadonlySet<string>
  readonly onToggle: (path: string) => void
}) {
  const container = isContainer(value)
  const entries = container ? entriesOf(value) : []
  const open = container && !collapsed.has(path)

  return (
    <div>
      <div
        className="flex items-start gap-1.5 py-0.5 font-mono text-[13px] leading-relaxed"
        style={{ paddingLeft: depth * 16 }}
      >
        {container ? (
          <button
            type="button"
            onClick={() => onToggle(path)}
            aria-expanded={open}
            aria-label={`${open ? 'Recolher' : 'Expandir'} ${label ?? 'nó raiz'}`}
            className="-ml-1 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        ) : (
          <span aria-hidden className="mt-0.5 w-4 shrink-0" />
        )}

        {label !== null && (
          <>
            <span className="shrink-0 text-sky-800">{label}</span>
            <span className="shrink-0 text-foreground/50">:</span>
          </>
        )}

        {container ? (
          <span className="text-foreground/70">
            {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        ) : (
          <span className={cn('break-all', primitiveClass(value))}>{primitiveText(value)}</span>
        )}
      </div>

      {open &&
        entries.map(([key, child]) => (
          <JsonNode
            key={`${path}.${key}`}
            label={Array.isArray(value) ? `${key}` : key}
            value={child}
            path={`${path}.${key}`}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </div>
  )
}

export interface JsonViewerProps {
  readonly value: JsonValue
  readonly initialExpansion?: 'auto' | 'expanded' | 'collapsed'
  readonly className?: string
}

export function JsonViewer({ value, initialExpansion = 'auto', className }: JsonViewerProps) {
  const pretty = JSON.stringify(value, null, 2) ?? 'null'
  const lines = pretty.split('\n')
  const [view, setView] = useState<'tree' | 'raw'>('tree')
  const [wrap, setWrap] = useState(false)
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        initialExpansion === 'expanded'
          ? []
          : collectContainerPaths(value, '$', 0, [], initialExpansion === 'collapsed' ? 0 : 1),
      ),
  )
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggleNode = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const expandAll = (): void => {
    setCollapsed(new Set())
  }

  const collapseAll = (): void => {
    setCollapsed(new Set(collectContainerPaths(value, '$', 0)))
  }

  const handleCopy = async (): Promise<void> => {
    const ok = await copyText(pretty)
    setCopyState(ok ? 'copied' : 'failed')
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopyState('idle'), 1600)
  }

  const linesWithNumbers = String(lines.length).length

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <div
          role="group"
          aria-label="Modo de visualização do JSON"
          className="inline-flex rounded-md border border-border bg-card p-0.5"
        >
          <button
            type="button"
            aria-pressed={view === 'tree'}
            onClick={() => setView('tree')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view === 'tree' ? 'bg-primary text-primary-foreground' : 'text-foreground/70 hover:bg-accent',
            )}
          >
            <Braces className="h-3.5 w-3.5" aria-hidden />
            Árvore
          </button>
          <button
            type="button"
            aria-pressed={view === 'raw'}
            onClick={() => setView('raw')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view === 'raw' ? 'bg-primary text-primary-foreground' : 'text-foreground/70 hover:bg-accent',
            )}
          >
            <WrapText className="h-3.5 w-3.5" aria-hidden />
            Bruto
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {view === 'tree' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={expandAll}
                className="h-7 px-2 text-[13px]"
              >
                <Expand className="mr-1 h-3.5 w-3.5" aria-hidden />
                Expandir JSON
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={collapseAll}
                className="h-7 px-2 text-[13px]"
              >
                <Shrink className="mr-1 h-3.5 w-3.5" aria-hidden />
                Recolher JSON
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={wrap}
              onClick={() => setWrap((current) => !current)}
              className="h-7 px-2 text-[13px]"
            >
              <WrapText className="mr-1 h-3.5 w-3.5" aria-hidden />
              Quebrar linha
            </Button>
          )}
          {view === 'raw' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={showLineNumbers}
              onClick={() => setShowLineNumbers((current) => !current)}
              className="h-7 px-2 text-[13px]"
            >
              Números
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
            aria-label="Copiar JSON"
            className="h-7 px-2 text-[13px]"
          >
            {copyState === 'copied' ? (
              <Check className="mr-1 h-3.5 w-3.5 text-emerald-700" aria-hidden />
            ) : (
              <Copy className="mr-1 h-3.5 w-3.5" aria-hidden />
            )}
            {copyState === 'copied' ? 'Copiado' : copyState === 'failed' ? 'Falhou' : 'Copiar'}
          </Button>
        </div>
      </div>

      {view === 'tree' ? (
        <div className="p-3">
          <JsonNode
            label={null}
            value={value}
            path="$"
            depth={0}
            collapsed={collapsed}
            onToggle={toggleNode}
          />
        </div>
      ) : (
        <div className={cn('bg-muted/20', wrap ? 'overflow-x-hidden' : 'overflow-x-auto')}>
          <pre className="min-w-full p-4 font-mono text-[13px] leading-[1.6]">
            <code>
              {lines.map((line, index) => (
                <span key={index} className="flex">
                  {showLineNumbers && (
                    <span
                      aria-hidden
                      className="mr-3 inline-block shrink-0 select-none text-right text-foreground/40"
                      style={{ width: `${linesWithNumbers}ch` }}
                    >
                      {index + 1}
                    </span>
                  )}
                  <span className={cn('flex-1', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
                    {tokenizeLine(line).map((token, tokenIndex) => (
                      <span key={tokenIndex} className={KIND_CLASS[token.kind]}>
                        {token.text}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  )
}
