import { DEFAULT_CREDENTIAL_TTL_SECONDS } from '@comprova/core'
import type { AssertionSource } from '@comprova/credential'
import { describe, expect, it } from 'vitest'
import { credentialValidUntilOf } from './credential-issuer.js'

const source = (
  completedAt: Date,
  observations: ReadonlyArray<{ readonly observedAt: Date; readonly ttlSeconds: number }>,
): Pick<AssertionSource, 'validation' | 'observations'> =>
  ({
    validation: { completedAt },
    observations: observations.map((entry, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      checker: 'registry_match',
      checkerVersion: '1',
      stance: 'supports',
      strength: 0.9,
      confidence: 0.9,
      source: 'receita',
      observedAt: entry.observedAt,
      ttlSeconds: entry.ttlSeconds,
      evidenceSha256: null,
      detail: {},
    })),
  }) as unknown as Pick<AssertionSource, 'validation' | 'observations'>

describe('credentialValidUntilOf', () => {
  const completedAt = new Date('2026-01-01T00:00:00.000Z')

  it('usa policy.credential_ttl_seconds quando as evidências duram mais', () => {
    const validUntil = credentialValidUntilOf(
      source(completedAt, [
        { observedAt: new Date('2026-01-01T00:00:00.000Z'), ttlSeconds: 60 * 24 * 60 * 60 },
      ]),
      2 * 60 * 60,
    )
    expect(validUntil.toISOString()).toBe('2026-01-01T02:00:00.000Z')
  })

  it('policy sem o campo usa o default de 30 dias', () => {
    const validUntil = credentialValidUntilOf(
      source(completedAt, [{ observedAt: completedAt, ttlSeconds: DEFAULT_CREDENTIAL_TTL_SECONDS }]),
    )
    expect(validUntil.toISOString()).toBe('2026-01-31T00:00:00.000Z')
  })

  it('TTL curto de UMA evidência limita a credencial (o veredito depende dela)', () => {
    const validUntil = credentialValidUntilOf(
      source(completedAt, [
        { observedAt: new Date('2026-01-01T00:00:00.000Z'), ttlSeconds: 30 * 24 * 60 * 60 },
        { observedAt: new Date('2026-01-01T00:10:00.000Z'), ttlSeconds: 60 },
      ]),
    )
    expect(validUntil.toISOString()).toBe('2026-01-01T00:11:00.000Z')
  })

  it('pode devolver exatamente completed_at (a fronteira rejeita a janela vazia)', () => {
    const validUntil = credentialValidUntilOf(
      source(completedAt, [{ observedAt: completedAt, ttlSeconds: 0 }]),
    )
    expect(validUntil.getTime()).toBe(completedAt.getTime())
  })

  it('não usa expires_at/retenção: só completed_at + policy e evidências', () => {
    const validUntil = credentialValidUntilOf(
      source(completedAt, [{ observedAt: new Date('2026-01-01T00:00:00.000Z'), ttlSeconds: 3600 }]),
      60,
    )
    expect(validUntil.toISOString()).toBe('2026-01-01T00:01:00.000Z')
  })
})
