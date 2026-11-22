interface Env {
  API_KEY: string
  ASSETS: Fetcher
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<any>): void
  passThroughOnException(): void
}

declare interface ExportedHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response
}
