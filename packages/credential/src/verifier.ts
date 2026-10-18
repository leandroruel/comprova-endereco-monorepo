import type { KeyObject } from 'node:crypto'
import { ASSERTION_METHOD, verifyDataIntegrityProof, type DataIntegrityFailure } from './data-integrity.js'
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
  | 'PROOF_PURPOSE_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'EVIDENCE_SET_MISMATCH'
  | 'INVALID_SIGNATURE'

export type CredentialVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: CredentialVerificationFailure }

/**
 * Método de verificação em que o consumidor confia: a chave pública **e** o
 * identificador do método ao qual ela está vinculada
 * (`<issuer>#<keyId>`, como em `verificationMethodOf`).
 *
 * A identidade é obrigatória: um `KeyObject` avulso não declara em QUEM se está
 * confiando, e aceitar só a chave deixaria a credencial escolher o
 * `verificationMethod` que quer ser (integridade criptográfica ≠ confiança na
 * chave do issuer — ADR-0024 §6).
 */
export interface TrustedVerificationMethod {
  readonly id: string
  readonly publicKey: KeyObject
}

export interface VerifierOptions {
  /** Método de verificação confiável (obrigatório; ver `TrustedVerificationMethod`). */
  readonly trusted: TrustedVerificationMethod
  /**
   * Issuer esperado. Quando informado, precisa ser exatamente o `issuer` da
   * credencial; quando omitido, o issuer é o que o `trusted.id` já delimita.
   */
  readonly expectedIssuerId?: string
}

const proofFailure = (reason: DataIntegrityFailure): CredentialVerificationFailure => {
  switch (reason) {
    case 'UNSUPPORTED_CRYPTOSUITE':
      return 'UNSUPPORTED_CRYPTOSUITE'
    case 'PROOF_PURPOSE_MISMATCH':
      return 'PROOF_PURPOSE_MISMATCH'
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
 * parseado) e o método de verificação confiável. NÃO acessa PostgreSQL, Redis,
 * Temporal, S3 nem a API: a integridade e a assinatura são verificadas só com o
 * material da credencial.
 *
 * O que é verificado, nesta ordem:
 *  1. forma do documento (VC 2.0 + extensões Comprova);
 *  2. `@context[0]` e `type` de uma Verifiable Credential;
 *  3. expectativa de issuer (quando fornecida);
 *  4. coerência estrutural `verificationMethod ↔ issuer` declarado (§5.9) e
 *     vínculo com o método confiável: o `verificationMethod` precisa ser
 *     EXATAMENTE `options.trusted.id` (§4);
 *  5. a janela de validade (`validFrom` ≤ `validUntil`);
 *  6. o binding do conjunto de evidências (recomputado a partir da própria
 *     credencial — nunca do material físico);
 *  7. o proof Data Integrity `eddsa-jcs-2022` sobre o documento CRU (o JSON
 *     recebido, sem o `proof`), com a chave pública confiável, exigindo
 *     `proofPurpose: assertionMethod`.
 *
 * Escopo: este verificador cobre integridade criptográfica e o vínculo entre a
 * chave confiável e a identidade declarada. Ele NÃO decide validade temporal da
 * credencial (expirada é política do consumidor), NEM status/revogação, NEM se
 * o issuer é uma entidade legítima — essas são responsabilidades distintas, e
 * misturá-las é o que a API de `trusted` evita (ADR-0024 §6).
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

  // §5.9 Verification Method Binding: sem resolução remota de chave, o binding é
  // estrutural — o método de verificação precisa pertencer ao issuer declarado
  // (`<issuer>#<keyId>`, com fragmento não vazio). Sem esta checagem, um
  // documento assinado por A poderia se declarar emitido por B e passaria.
  const verificationMethod = secured.proof.verificationMethod
  const issuerFragment = `${secured.issuer}#`
  if (!verificationMethod.startsWith(issuerFragment) || verificationMethod.length === issuerFragment.length) {
    return { valid: false, reason: 'VERIFICATION_METHOD_MISMATCH' }
  }
  // Vínculo com a chave confiável: a assinatura tem de ser do método que o
  // consumidor declarou confiar. Só a chave pública não basta — ela é
  // reaproveitável entre métodos (`#key-1`, `#key-2`) do mesmo issuer.
  if (verificationMethod !== options.trusted.id) {
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

  const proof = verifyDataIntegrityProof(raw, {
    publicKey: options.trusted.publicKey,
    expectedProofPurpose: ASSERTION_METHOD,
  })
  if (!proof.valid) return { valid: false, reason: proofFailure(proof.reason) }

  return { valid: true }
}
