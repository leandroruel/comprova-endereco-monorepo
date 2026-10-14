import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export interface Metrics {
  registry: Registry
  httpRequests: Counter<string>
  httpDuration: Histogram<string>
  httpErrors: Counter<string>
}

export function createMetrics(): Metrics {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  })

  const httpErrors = new Counter({
    name: 'http_errors_total',
    help: 'Total HTTP requests resulting in 5xx',
    labelNames: ['method', 'route'],
    registers: [registry],
  })

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.04, 0.05, 0.1, 0.12, 0.25, 0.5, 1, 2.5, 5, 15],
    registers: [registry],
  })

  return { registry, httpRequests, httpDuration, httpErrors }
}
