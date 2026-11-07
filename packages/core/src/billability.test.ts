import { describe, expect, it } from 'vitest'
import { hasExternalUnavailability, unavailabilityCauseOfSignal } from './billability.js'
import type { Signal } from './types.js'

const sig = (overrides: Partial<Signal> = {}): Signal => ({
  checkerId: 'registry_status',
  checkerVersion: '1.0.0',
  stance: 'unknown',
  strength: 0,
  confidence: 0,
  source: 'registry_status',
  observedAt: '2026-11-06T00:00:00.000Z',
  ttlSeconds: 300,
  detail: {},
  ...overrides,
})

describe('política de faturabilidade (ADR-0044 §3)', () => {
  it('timeout de checker (fonte sufixada :timeout) é indisponibilidade', () => {
    const cause = unavailabilityCauseOfSignal(
      sig({ source: 'registry_status:timeout', detail: { reason: 'checker_timeout' } }),
    )
    expect(cause).toBe('checker_timeout')
  })

  it('timeout de checker detectado só pela convenção de source', () => {
    const cause = unavailabilityCauseOfSignal(sig({ source: 'cep_consistency:timeout' }))
    expect(cause).toBe('checker_timeout')
  })

  it('fonte externa indisponível é indisponibilidade', () => {
    const cause = unavailabilityCauseOfSignal(sig({ detail: { reason: 'source_unavailable' } }))
    expect(cause).toBe('source_unavailable')
  })

  it('falha interna de processamento é indisponibilidade', () => {
    const cause = unavailabilityCauseOfSignal(sig({ detail: { reason: 'internal_error' } }))
    expect(cause).toBe('internal_error')
  })

  it('resultado negativo legítimo (not_in_registry) NÃO é indisponibilidade', () => {
    const cause = unavailabilityCauseOfSignal(sig({ detail: { reason: 'not_in_registry' } }))
    expect(cause).toBeNull()
  })

  it('evidência insuficiente legítima (cep_missing, address_not_resolved) NÃO é indisponibilidade', () => {
    expect(
      unavailabilityCauseOfSignal(sig({ checkerId: 'cep_consistency', detail: { reason: 'cep_missing' } })),
    ).toBeNull()
    expect(
      unavailabilityCauseOfSignal(
        sig({ checkerId: 'cnefe_match', detail: { reason: 'address_not_resolved' } }),
      ),
    ).toBeNull()
  })

  it('sinal com stance supports/contradicts nunca é indisponibilidade', () => {
    expect(unavailabilityCauseOfSignal(sig({ stance: 'supports', source: 'x:timeout' }))).toBeNull()
    expect(
      unavailabilityCauseOfSignal(sig({ stance: 'contradicts', detail: { reason: 'checker_timeout' } })),
    ).toBeNull()
  })

  it('hasExternalUnavailability detecta qualquer indisponibilidade no conjunto', () => {
    expect(
      hasExternalUnavailability([
        sig({ stance: 'supports' }),
        sig({ checkerId: 'cep_consistency', detail: { reason: 'cep_missing' } }),
      ]),
    ).toBe(false)
    expect(
      hasExternalUnavailability([sig({ stance: 'supports' }), sig({ source: 'registry_status:timeout' })]),
    ).toBe(true)
  })

  it('conjunto vazio não tem indisponibilidade', () => {
    expect(hasExternalUnavailability([])).toBe(false)
  })
})
