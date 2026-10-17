import { verify as ed25519Verify, type KeyObject } from 'node:crypto'
import { CredentialSchema } from './assertion.js'
import { canonicalAssertionBytes } from './canonical.js'
import { evidenceSetHashOfCredential } from './evidence.js'

export type CredentialVerificationFailure =
  | 'MALFORMED_CREDENTIAL'
  | 'ISSUER_MISMATCH'
  | 'KEY_ID_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'EVIDENCE_SET_MISMATCH'
  | 'INVALID_SIGNATURE'

export type CredentialVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: CredentialVerificationFailure }

export interface VerifierOptions {
  /** Chave pública do issuer, fornecida diretamente (MVP). Resolver a chave é dependência da camada de resolução. */
  readonly publicKey: KeyObject
  readonly expectedIssuerId?: string
  readonly expectedKeyId?: string
}

/**
 * Verificador independente (FASE 11). Recebe apenas a credencial (JSON já
 * parseado) e a chave pública. NÃO acessa PostgreSQL, Redis, Temporal, S3 nem a
 * API: a integridade e a assinatura são verificadas só com o material da
 * credencial.
 */
export const verifyCredential = (
  credential: unknown,
  options: VerifierOptions,
): CredentialVerificationResult => {
  const parsed = CredentialSchema.safeParse(credential)
  if (!parsed.success) return { valid: false, reason: 'MALFORMED_CREDENTIAL' }

  const { payload, proof } = parsed.data

  if (options.expectedIssuerId !== undefined && payload.issuer.id !== options.expectedIssuerId) {
    return { valid: false, reason: 'ISSUER_MISMATCH' }
  }
  if (options.expectedKeyId !== undefined && proof.key_id !== options.expectedKeyId) {
    return { valid: false, reason: 'KEY_ID_MISMATCH' }
  }

  const createdAt = Date.parse(payload.timestamps.created_at)
  const expiresAt = Date.parse(payload.timestamps.expires_at)
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > expiresAt) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' }
  }

  if (evidenceSetHashOfCredential(payload.evidence.observations) !== payload.evidence.set_hash) {
    return { valid: false, reason: 'EVIDENCE_SET_MISMATCH' }
  }

  let signatureOk = false
  try {
    signatureOk = ed25519Verify(
      null,
      Buffer.from(canonicalAssertionBytes(payload)),
      options.publicKey,
      Buffer.from(proof.signature, 'base64url'),
    )
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE' }
  }
  if (!signatureOk) return { valid: false, reason: 'INVALID_SIGNATURE' }

  return { valid: true }
}
