import { describe, expect, it } from 'vitest'
import { DEFAULT_CREDENTIAL_TTL_SECONDS, loadPolicy } from './policy.js'

const policyYaml = (extra = ''): string => `
version: '2026.13.1'
weights:
  registry_status: 1.0
hard_rules: []
required_checkers:
  - registry_status
decision:
  insufficient_band: [-0.2, 0.2]
  conflict_threshold: 0.45
  confirmed_threshold: 0.35
${extra}`

const evidenceYaml = `evidence_checkers:
  nf3e_verification:
    strength: 0.4
    confidence: 0.8
`

describe('PolicySchema — evidence_checkers', () => {
  it('policy já publicada (sem o campo) parseia com mapa vazio', () => {
    expect(loadPolicy(policyYaml()).evidence_checkers).toEqual({})
  })

  it('policy nova declara força por checker', () => {
    expect(loadPolicy(policyYaml(evidenceYaml)).evidence_checkers).toEqual({
      nf3e_verification: { strength: 0.4, confidence: 0.8 },
    })
  })

  it('recusa força fora de [0, 1]', () => {
    expect(() =>
      loadPolicy(
        policyYaml(`evidence_checkers:
  nf3e_verification:
    strength: 1.5
    confidence: 0.8
`),
      ),
    ).toThrow()
    expect(() =>
      loadPolicy(
        policyYaml(`evidence_checkers:
  nf3e_verification:
    strength: 0.4
    confidence: -0.1
`),
      ),
    ).toThrow()
  })
})

describe('PolicySchema — credential_ttl_seconds', () => {
  it('policy já publicada (sem o campo) usa 30 dias sem alterar o YAML/hash', () => {
    expect(loadPolicy(policyYaml()).credential_ttl_seconds).toBe(DEFAULT_CREDENTIAL_TTL_SECONDS)
    expect(DEFAULT_CREDENTIAL_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it('policy nova pode declarar um TTL próprio', () => {
    expect(loadPolicy(policyYaml('credential_ttl_seconds: 3600\n')).credential_ttl_seconds).toBe(3600)
  })

  it('recusa TTL não positivo', () => {
    expect(() => loadPolicy(policyYaml('credential_ttl_seconds: 0\n'))).toThrow()
    expect(() => loadPolicy(policyYaml('credential_ttl_seconds: -1\n'))).toThrow()
  })
})
