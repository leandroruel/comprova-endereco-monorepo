/**
 * Trace opcional para diagnóstico de um artefato.
 *
 * O callback é usado apenas por rotas administrativas de debug. Ele nunca
 * participa da decisão do analyzer: falhas ou exceções do sink são engolidas
 * para que observar o pipeline não mude o resultado observado.
 */
export type DebugTraceLevel = 'info' | 'success' | 'warning' | 'error'

export interface DebugTraceEvent {
  /** Código estável, em inglês, adequado para filtros e testes. */
  readonly code: string
  readonly level: DebugTraceLevel
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export type DebugTraceSink = (event: DebugTraceEvent) => void

export const emitDebug = (sink: DebugTraceSink | undefined, event: DebugTraceEvent): void => {
  if (sink === undefined) return
  try {
    sink(event)
  } catch {
    // Diagnóstico é best-effort; o pipeline principal não pode falhar por causa do trace.
  }
}
