import type { Stance } from './types.js'

export type ClaimType = 'business_registered_address' | 'address_exists'

export type SubjectType = 'organization' | 'person'

export type ClaimTargetType = 'address'

export interface ClaimSubject {
  readonly type: SubjectType
  readonly refId: string
}

export interface ClaimTarget {
  readonly type: ClaimTargetType
  readonly refId: string | null
}

export interface Claim {
  readonly id: string
  readonly type: ClaimType
  readonly subject: ClaimSubject
  readonly target: ClaimTarget
}

export function isClaimType(value: string): value is ClaimType {
  return value === 'business_registered_address' || value === 'address_exists'
}

export function isSubjectType(value: string): value is SubjectType {
  return value === 'organization' || value === 'person'
}

export const VALID_CLAIM_SUBJECT_MATRIX: Readonly<Record<ClaimType, readonly SubjectType[]>> = {
  business_registered_address: ['organization'],
  address_exists: ['organization', 'person'],
} as const

export function isValidClaimCombination(claimType: ClaimType, subjectType: SubjectType): boolean {
  const allowed = VALID_CLAIM_SUBJECT_MATRIX[claimType]
  return allowed?.includes(subjectType) ?? false
}

export interface AddressClaimSpec {
  readonly type: ClaimType
  readonly subjectType: SubjectType
}

/**
 * Claim canônica de verificação de endereço de uma Validation.
 *
 * A regra é a mesma usada pelo intake F1.1 desde o ADR-0037: o tipo é derivado
 * do documento do subject. CNPJ → `business_registered_address`/`organization`;
 * qualquer outro documento (CPF) → `address_exists`/`person`.
 *
 * As duas variantes têm `target_type = 'address'`, mas são finalidades
 * distintas: uma Validation pode conter mais de uma Claim. O fluxo de
 * comprovante de residência só pode usar a Claim derivada do subject.
 */
export const addressClaimForSubjectDocType = (docType: string): AddressClaimSpec =>
  docType === 'CNPJ'
    ? { type: 'business_registered_address', subjectType: 'organization' }
    : { type: 'address_exists', subjectType: 'person' }

export type EvidenceStance = 'supports' | 'contradicts' | 'unknown'

export interface Evidence {
  readonly id: string
  readonly claimId: string
  readonly checker: string
  readonly checkerVersion: string
  /**
   * Posição da evidência. Em memória espelha fielmente o stance do signal
   * (pode ser `neutral`), o que mantém o scoring idêntico ao pipeline de signals.
   * Na persistência o enum de 3 valores é usado (`neutral` → `unknown`).
   */
  readonly stance: Stance
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: string
  readonly ttlSeconds: number
  readonly detail: Record<string, unknown>
  readonly signalId: string | null
}

export interface AssessmentExplanation {
  readonly code: string
  readonly message: string
  readonly supportingEvidenceIds: readonly string[]
  readonly contradictingEvidenceIds: readonly string[]
}

export interface Assessment {
  readonly claimId: string
  readonly verdict: string
  readonly score: number
  readonly confidence: number
  readonly policyVersion: string
  readonly evaluatedAt: string
  readonly explanation: AssessmentExplanation
}
