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

export type EvidenceStance = 'supports' | 'contradicts' | 'unknown'

export interface Evidence {
  readonly id: string
  readonly claimId: string
  readonly checker: string
  readonly checkerVersion: string
  readonly stance: EvidenceStance
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
