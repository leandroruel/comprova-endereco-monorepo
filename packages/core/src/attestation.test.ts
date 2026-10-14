import { describe, expect, it } from 'vitest'
import { makeStubAttestationVerifier } from './attestation.js'

describe('AttestationVerifier (stub Fase 5)', () => {
  it('stub rejeita com motivo claro ate a implementacao real', async () => {
    const verifier = makeStubAttestationVerifier()
    const result = await verifier.verify({
      format: 'bbs-plus',
      issuer: 'gov-br',
      claims: { country: 'BR', municipalityIbge: 3550308 },
      proof: 'deadbeef',
    })
    expect(result.verified).toBe(false)
    expect(result.reason).toContain('stub')
  })
})
