import type { Signal } from './types.js'

/**
 * Política provisória de faturabilidade (ADR-0044 §3): uma validação concluída
 * só é faturável quando o resultado entregue não decorre de indisponibilidade
 * de fonte externa. Conclusão técnica (`validation.status`) e elegibilidade
 * comercial (`billable`) são conceitos independentes — esta política decide
 * APENAS o segundo.
 *
 * Motivos que tornam um sinal `unknown` uma INDISPONIBILIDADE (não faturável):
 *
 * - `checker_timeout` — o checker excedeu o próprio `timeoutMs` (fast path
 *   registra `source: '<checker>:timeout'` e `detail.reason = 'checker_timeout'`).
 * - `source_unavailable` — a fonte externa respondeu indisponível.
 * - `internal_error` — falha interna de processamento do checker.
 *
 * Um sinal `unknown` com qualquer outro motivo (ex.: `not_in_registry`,
 * `cep_missing`, `address_not_resolved`, `no_profile`) é um resultado legítimo
 * do checker — ele executou e respondeu "não sei" — e NÃO impede o faturamento.
 */
export type ExternalUnavailabilityCause = 'checker_timeout' | 'source_unavailable' | 'internal_error'

/** Motivos de `detail.reason` que caracterizam indisponibilidade (não faturável). */
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'checker_timeout',
  'source_unavailable',
  'internal_error',
])

/**
 * Causa de indisponibilidade de um sinal, ou `null` quando o sinal representa
 * um resultado legítimo do checker (inclusive `unknown` sem motivo de
 * indisponibilidade).
 */
export const unavailabilityCauseOfSignal = (signal: Signal): ExternalUnavailabilityCause | null => {
  // Timeout do fast path chega como `stance: 'unknown'` com `source` sufixado.
  if (signal.stance !== 'unknown') return null
  if (signal.source.endsWith(':timeout')) return 'checker_timeout'
  const reason = signal.detail?.['reason']
  if (typeof reason !== 'string') return null
  if (reason === 'checker_timeout') return 'checker_timeout'
  if (reason === 'source_unavailable') return 'source_unavailable'
  if (reason === 'internal_error') return 'internal_error'
  // Qualquer outro motivo é resultado legítimo (não indisponibilidade), mas
  // mantemos o conjunto fechado: motivos novos de indisponibilidade precisam
  // ser adicionados aqui explicitamente (UNAVAILABLE_REASONS documenta isso).
  void UNAVAILABLE_REASONS
  return null
}

/**
 * Há alguma indisponibilidade de fonte externa no conjunto de sinais?
 * Usado para decidir `billable` de forma consistente entre fast e deep.
 */
export const hasExternalUnavailability = (signals: readonly Signal[]): boolean =>
  signals.some((signal) => unavailabilityCauseOfSignal(signal) !== null)
