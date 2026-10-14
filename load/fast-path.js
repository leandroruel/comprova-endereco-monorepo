import http from 'k6/http'
import { check } from 'k6'

export const options = {
  scenarios: {
    fast_path: {
      executor: 'constant-arrival-rate',
      rate: __ENV.RPS ? parseInt(__ENV.RPS) : 300,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<120'],
    checks: ['rate>0.99'],
  },
}

const BASE = __ENV.BASE_URL ?? 'http://localhost:3000'
const KEY = __ENV.API_KEY
const CNPJ = __ENV.CNPJ ?? '12345678000195'

export default function () {
  const res = http.post(
    `${BASE}/v1/validations`,
    JSON.stringify({
      document: { type: 'CNPJ', value: CNPJ },
      address: null,
      mode: 'fast',
      legal_basis: 'FRAUD_PREVENTION',
    }),
    {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `k6-${__VU}-${__ITER}`,
      },
    },
  )
  check(res, {
    'status 200': (r) => r.status === 200,
    'tem veredito': (r) => r.json('verdict') !== undefined,
  })
}
