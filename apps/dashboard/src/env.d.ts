interface Env {
  API_KEY: string
  API_BASE: string
  DASHBOARD_ORIGIN: string
  ASSETS: Fetcher
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<any>): void
  passThroughOnException(): void
}

/** Evento do Cron Trigger do Workers (recebido pelo handler `scheduled`). */
declare interface ScheduledController {
  readonly scheduledTime: number
  readonly cron: string
  noRetry(): void
}

declare interface ExportedHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): void | Promise<void>
}
