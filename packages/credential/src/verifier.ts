import type { KeyObject } from 'node:crypto'
import { verifyDataIntegrityProof, type DataIntegrityFailure } from './data-integrity.js'
import { evidenceSetHashOfCredential } from './evidence.js'
import {
  observationOfEvidence,
  SecuredVerifiableCredentialSchema,
  VC_CONTEXT_URL,
  VERIFIABLE_CREDENTIAL_TYPE,
} from './vc.js'

export type CredentialVerificationFailure =
  | 'MALFORMED_CREDENTIAL'
  | 'UNSUPPORTED_CREDENTIAL'
  | 'UNSUPPORTED_CRYPTOSUITE'
  | 'ISSUER_MISMATCH'
  | 'VERIFICATION_METHOD_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'EVIDENCE_SET_MISMATCH'
  | 'INVALID_SIGNATURE'

export type CredentialVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: CredentialVerificationFailure }

export interface VerifierOptions {
  /** Chave pública do issuer, fornecida diretamente (MVP). Resolver a chave é dependência da camada de resolução. */
  readonly publicKey: KeyObject
  readonly expectedIssuerId?: string
  /** `proof.verificationMethod` esperado (ex.: `comprova:issuer:<tenant>#<keyId>`). */
  readonly expectedVerificationMethod?: string
}

const proofFailure = (reason: DataIntegrityFailure): CredentialVerificationFailure => {
  switch (reason) {
    case 'UNSUPPORTED_CRYPTOSUITE':
      return 'UNSUPPORTED_CRYPTOSUITE'
    case 'INVALID_SIGNATURE':
      return 'INVALID_SIGNATURE'
    case 'MALFORMED_PROOF':
    case 'PROOF_CONTEXT_MISMATCH':
    case 'INVALID_PROOF_VALUE':
      return 'MALFORMED_CREDENTIAL'
  }
}

const timestampOf = (value: string): number | null => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Verificador independente (FASE 11). Recebe apenas a credencial (JSON já
 * parseado) e a chave pública. NÃO acessa PostgreSQL, Redis, Temporal, S3 nem a
 * API: a integridade e a assinatura são verificadas só com o material da
 * credencial.
 *
 * O que é verificado, nesta ordem:
 *  1. forma do documento (VC 2.0 + extensões Comprova);
 *  2. `@context[0]` e `type` de uma Verifiable Credential;
 *  3. expectativas de issuer e de `verificationMethod`, quando fornecidas;
 *  4. a janela de validade (`validFrom` ≤ `validUntil`);
 *  5. o binding do conjunto de evidências (recomputado a partir da própria
 *     credencial — nunca do material físico);
 *  6. o proof Data Integrity `eddsa-jcs-2022` sobre o documento CRU (o JSON
 *     recebido, sem o `proof`).
 */
export const verifyCredential = (
  credential: unknown,
  options: VerifierOptions,
): CredentialVerificationResult => {
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
    return { valid: false, reason: 'MALFORMED_CREDENTIAL' }
  }
  const raw = credential as Record<string, unknown>

  const parsed = SecuredVerifiableCredentialSchema.safeParse(raw)
  if (!parsed.success) return { valid: false, reason: 'MALFORMED_CREDENTIAL' }
  const secured = parsed.data

  if (secured['@context'][0] !== VC_CONTEXT_URL || !secured.type.includes(VERIFIABLE_CREDENTIAL_TYPE)) {
    return { valid: false, reason: 'UNSUPPORTED_CREDENTIAL' }
  }
  if (options.expectedIssuerId !== undefined && secured.issuer !== options.expectedIssuerId) {
    return { valid: false, reason: 'ISSUER_MISMATCH' }
  }
  if (
    options.expectedVerificationMethod !== undefined &&
    secured.proof.verificationMethod !== options.expectedVerificationMethod
  ) {
    return { valid: false, reason: 'VERIFICATION_METHOD_MISMATCH' }
  }

  const validFrom = timestampOf(secured.validFrom)
  const validUntil = secured.validUntil === undefined ? null : timestampOf(secured.validUntil)
  if (validFrom === null || (secured.validUntil !== undefined && validUntil === null)) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' }
  }
  if (validUntil !== null && validFrom > validUntil) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' }
  }

  if (
    evidenceSetHashOfCredential(secured.evidence.map(observationOfEvidence)) !==
    secured['comprova:evidenceSetHash']
  ) {
    return { valid: false, reason: 'EVIDENCE_SET_MISMATCH' }
  }

  const proof = verifyDataIntegrityProof(raw, { publicKey: options.publicKey })
  if (!proof.valid) return { valid: false, reason: proofFailure(proof.reason) }

  return { valid: true }
}
