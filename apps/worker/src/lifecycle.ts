import type { Logger } from '@comprova/observability'
import type { StopLoop } from './loops.js'

/** Sinais tratados pelo worker. */
export type WorkerSignal = 'SIGTERM' | 'SIGINT'

/**
 * Fonte de sinais injetável nos testes. Em produção é `process`; nos testes,
 * um emissor controlado evita depender do envio real de sinais do SO.
 */
export interface WorkerSignalSource {
  readonly on: (signal: WorkerSignal, listener: () => void) => void
}

export interface WorkerLifecycleDeps {
  /**
   * Inicia os loops e registra cada `stop` via `track`. Pode lançar: nesse
   * caso o lifecycle já executou o shutdown dos recursos registrados até aqui.
   */
  readonly start: (track: (stop: StopLoop) => void) => void
  /** Fecha pools/recursos. Só roda depois que todos os loops pararam. */
  readonly close: () => Promise<void>
  readonly logger: Logger
  /** Injetável nos testes; default `process`. */
  readonly signals?: WorkerSignalSource
}

export type WorkerRunResult = 'shutdown' | 'boot_failure'

const SIGNALS: readonly WorkerSignal[] = ['SIGTERM', 'SIGINT']

const errorFields = (error: unknown): { error_name: string; error_message: string } => ({
  error_name: error instanceof Error ? error.name : 'unknown',
  error_message: error instanceof Error ? error.message : String(error),
})

/**
 * Mantém o worker ativo enquanto os loops rodam e encerra de forma graciosa
 * em `SIGTERM`/`SIGINT`.
 *
 * Garantias:
 *   - os loops são iniciados uma única vez;
 *   - um sinal impede novos ticks e aguarda o tick em andamento;
 *   - os pools só fecham depois que todos os loops pararam;
 *   - sinais repetidos reaproveitam o mesmo shutdown (idempotente);
 *   - falha no boot executa o mesmo shutdown antes de retornar `boot_failure`.
 */
export const runWorkerLifecycle = async (deps: WorkerLifecycleDeps): Promise<WorkerRunResult> => {
  const signalSource = deps.signals ?? process
  const stops: StopLoop[] = []
  let shutdownPromise: Promise<void> | null = null
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise
    shutdownPromise = (async () => {
      deps.logger.info({ reason }, 'worker shutdown started')
      // Ordem inversa da inicialização; cada stop aguarda o tick em voo.
      for (const stop of [...stops].reverse()) {
        try {
          await stop()
        } catch (error) {
          deps.logger.error({ reason, ...errorFields(error) }, 'worker loop stop failed')
        }
      }
      try {
        await deps.close()
      } catch (error) {
        deps.logger.error({ reason, ...errorFields(error) }, 'worker resource close failed')
      }
      deps.logger.info({ reason }, 'worker shutdown complete')
      resolveDone?.()
    })()
    return shutdownPromise
  }

  // Os listeners permanecem instalados durante o shutdown: um segundo sinal
  // reaproveita a promise acima em vez de derrubar o processo no meio da parada.
  for (const signal of SIGNALS) {
    signalSource.on(signal, () => {
      shutdown(`signal:${signal}`).catch((error: unknown) => {
        deps.logger.error({ signal, ...errorFields(error) }, 'worker shutdown failed')
      })
    })
  }

  try {
    deps.start((stop) => {
      stops.push(stop)
    })
  } catch (error) {
    deps.logger.error({ ...errorFields(error) }, 'worker boot failed')
    await shutdown('boot_failure')
    return 'boot_failure'
  }

  await done
  return 'shutdown'
}
