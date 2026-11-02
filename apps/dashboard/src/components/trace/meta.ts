import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { DebugTraceEventDto } from '@/api/client'

export type TraceLevel = DebugTraceEventDto['level']

export interface TraceEntry {
  readonly event: DebugTraceEventDto
  readonly index: number
}

export type TraceBadgeVariant = 'success' | 'info' | 'warning' | 'destructive'

export interface LevelMeta {
  readonly label: string
  readonly icon: LucideIcon
  readonly badge: TraceBadgeVariant
  readonly iconClass: string
  readonly textClass: string
}

/**
 * Um único lugar define ícone, rótulo e cor de cada status. O texto acompanha
 * sempre o ícone: a timeline nunca depende só de cor para comunicar o estado.
 */
export const LEVEL_META: Readonly<Record<TraceLevel, LevelMeta>> = {
  success: {
    label: 'Sucesso',
    icon: CircleCheck,
    badge: 'success',
    iconClass: 'text-emerald-600',
    textClass: 'text-emerald-800',
  },
  info: {
    label: 'Info',
    icon: Info,
    badge: 'info',
    iconClass: 'text-blue-600',
    textClass: 'text-blue-800',
  },
  warning: {
    label: 'Alerta',
    icon: TriangleAlert,
    badge: 'warning',
    iconClass: 'text-amber-600',
    textClass: 'text-amber-800',
  },
  error: {
    label: 'Erro',
    icon: CircleX,
    badge: 'destructive',
    iconClass: 'text-red-600',
    textClass: 'text-red-800',
  },
}

export const LEVELS: readonly TraceLevel[] = ['success', 'info', 'warning', 'error']

/** Modo de expansão das seções do JSON do passo selecionado. */
export type TraceExpansion = 'auto' | 'all' | 'none'

export const countByLevel = (events: readonly DebugTraceEventDto[]): Record<TraceLevel, number> => {
  const counts: Record<TraceLevel, number> = { success: 0, info: 0, warning: 0, error: 0 }
  for (const event of events) counts[event.level] += 1
  return counts
}

export const eventToJson = (event: DebugTraceEventDto): string => JSON.stringify(event, null, 2)

export const traceToJson = (events: readonly DebugTraceEventDto[]): string => JSON.stringify(events, null, 2)

/** Busca por código, mensagem, status ou conteúdo do payload. */
export const matchesQuery = (event: DebugTraceEventDto, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  const haystack = [
    event.code,
    event.message,
    event.level,
    LEVEL_META[event.level].label,
    event.details === undefined ? '' : JSON.stringify(event.details),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/** `null` quando o trace não traz duração — o contrato atual não inclui timestamps. */
export const formatDuration = (milliseconds: number | undefined): string | null => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return null
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  const seconds = milliseconds / 1000
  return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace('.', ',')} s`
}

/**
 * Copia com fallback para contextos sem Clipboard API (HTTP em rede local).
 * Devolve se a cópia foi confirmada, para o botão refletir o estado real.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Segue para o fallback.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
