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

declare interface ExportedHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response
}
