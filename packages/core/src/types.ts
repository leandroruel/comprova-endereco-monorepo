export type Stance = 'supports' | 'contradicts' | 'neutral' | 'unknown'

export type DocKind = 'CNPJ' | 'CPF'

import type { EstabelecimentoRecord } from './ports.js'

export interface Signal {
  checkerId: string
  checkerVersion: string
  stance: Stance
  strength: number
  confidence: number
  source: string
  observedAt: string
  ttlSeconds: number
  detail: Record<string, unknown>
  evidenceId?: string
}

export interface Clock {
  now(): Date
}

export interface SubjectRef {
  subjectId?: string
  docType: DocKind
  docDigitsValid: boolean
  pseudonymized: boolean
}

export interface CanonicalAddressRef {
  addressId?: string
  buildingKey?: Uint8Array
  unitKey?: Uint8Array
  country: string
  uf?: string
  cep?: string
  municipioIbge?: number
  logradouroNorm?: string
  numero?: string
  bairroNorm?: string
  exterior?: boolean
}

export interface CheckContext {
  subject: SubjectRef
  registryRecord?: EstabelecimentoRecord
  address: CanonicalAddressRef | null
  priorSignals: readonly Signal[]
  clock: Clock
  metrics: {
    increment(name: string, labels?: Record<string, string | number>): void
    observe(name: string, value: number, labels?: Record<string, string | number>): void
  }
}

export interface Checker {
  readonly id: string
  readonly version: string
  readonly tier: 0 | 1 | 2
  readonly appliesTo: ReadonlyArray<DocKind>
  readonly timeoutMs: number
  run(ctx: CheckContext, signal?: AbortSignal): Promise<readonly Signal[]>
}

export const systemClock: Clock = {
  now: () => new Date(),
}
