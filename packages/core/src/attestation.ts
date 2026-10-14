export interface AddressAttestation {
  readonly format: 'bbs-plus' | 'zk-snark' | 'jwt-vc'
  readonly issuer: string
  readonly claims: {
    readonly country?: string
    readonly municipalityIbge?: number
    readonly cepPrefix?: string
    readonly validUntil?: string
  }
  readonly proof: string
}

export interface AttestationResult {
  readonly verified: boolean
  readonly reason: string
  readonly claims?: AddressAttestation['claims']
}

export interface AttestationVerifier {
  readonly verify: (attestation: AddressAttestation) => Promise<AttestationResult>
}

export const makeStubAttestationVerifier = (): AttestationVerifier => ({
  verify: async () => ({
    verified: false,
    reason: 'verificacao de atestados ainda nao implementada (stub da Fase 5)',
  }),
})
