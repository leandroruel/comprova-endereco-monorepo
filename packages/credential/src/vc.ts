import { z } from 'zod'
import { HexSha256Schema, type AssertionPayload, type CredentialObservation } from './assertion.js'
import { DataIntegrityProofSchema } from './data-integrity.js'

/**
 * Documento W3C (VC Data Model 2.0). Este módulo é a ÚNICA camada que conhece a
 * forma W3C; ele é puramente um mapping do modelo interno da Comprova
 * (`AssertionPayload`) para o documento veriável. Não há segunda fonte de
 * verdade: o mapping é derivado, e a assertion interna continua sendo o
 * artefato normalizado do domínio.
 *
 *   AssertionSource → AssertionPayload (interno)
 *                   → VerifiableCredential (W3C)
 *                   → DataIntegrityProof (eddsa-jcs-2022)
 *
 * Terminologia W3C usada, sem invenção:
 *  - `@context`, `type`, `issuer`, `validFrom`, `validUntil` (§4.2–4.9);
 *  - `credentialSubject` (§4.8);
 *  - `evidence` (§5.6) — cada evidência tem `id` (opcional) e `type`
 *    (obrigatório);
 *  - `proof` (Data Integrity 1.0 §2.1).
 *
 * Tudo que é específico da Comprova vive no namespace
 * `https://comprova.dev/ns/credentials/v2#`, declarado no `@context` inline e
 * usado na forma de IRI compacto (`comprova:…`). Nenhum termo W3C é
 * redefinido nem inventado.
 */

export const VC_CONTEXT_URL = 'https://www.w3.org/ns/credentials/v2'
export const COMPROVA_CONTEXT_URL = 'https://comprova.dev/ns/credentials/v2#'

export const VERIFIABLE_CREDENTIAL_TYPE = 'VerifiableCredential'
export const COMPROVA_CREDENTIAL_TYPE = 'comprova:AddressCredential'
export const COMPROVA_SUBJECT_TYPE = 'comprova:AddressSubject'
export const COMPROVA_CLAIM_TYPE = 'comprova:AddressClaim'
export const COMPROVA_EVIDENCE_TYPE = 'comprova:Evidence'

/** `@context` do documento: o contexto base da VC 2.0 + o prefixo Comprova. */
const context = (): [typeof VC_CONTEXT_URL, { comprova: typeof COMPROVA_CONTEXT_URL }] => [
  VC_CONTEXT_URL,
  { comprova: COMPROVA_CONTEXT_URL },
]

const ComprovaAddressSchema = z.object({
  id: z.uuid().optional(),
  'comprova:buildingKey': z.string().min(1).optional(),
})

const ComprovaClaimSchema = z.object({
  id: z.uuid(),
  type: z.array(z.string()).min(1),
  'comprova:claimType': z.enum(['business_registered_address', 'address_exists']),
  'comprova:subjectType': z.enum(['organization', 'person']),
  /** `claim.target_type` do domínio. */
  'comprova:targetType': z.enum(['address']),
  'comprova:address': ComprovaAddressSchema,
})

const ComprovaEvidenceSchema = z.object({
  id: z.uuid(),
  type: z.array(z.string()).min(1),
  'comprova:checker': z.string().min(1),
  'comprova:checkerVersion': z.string().min(1),
  'comprova:stance': z.enum(['supports', 'contradicts', 'unknown']),
  'comprova:strength': z.number(),
  'comprova:confidence': z.number(),
  'comprova:source': z.string().min(1),
  'comprova:observedAt': z.iso.datetime(),
  /** Binding durável (`claim_evidence.evidence_sha256`); nunca `evidence_id`/`s3_uri`. */
  'comprova:evidenceSha256': HexSha256Schema.optional(),
  'comprova:detail': z.unknown(),
})

const ComprovaExplanationSchema = z.object({
  'comprova:code': z.string(),
  'comprova:summary': z.string(),
  'comprova:supportingEvidence': z.array(z.uuid()),
  'comprova:contradictingEvidence': z.array(z.uuid()),
})

const ComprovaResultSchema = z.object({
  'comprova:verdict': z.string().min(1),
  'comprova:score': z.number(),
  'comprova:confidence': z.number(),
  /** `validation.completed_at`; omitido quando nulo (não se inventa timestamp). */
  'comprova:completedAt': z.iso.datetime().optional(),
  'comprova:explanation': ComprovaExplanationSchema.optional(),
})

const ComprovaPolicySchema = z.object({
  'comprova:version': z.string().min(1),
  'comprova:hash': HexSha256Schema,
})

const ComprovaAlgorithmSchema = z.object({
  'comprova:scorerVersion': z.string().min(1),
})

const ComprovaAuthorizationSchema = z.object({
  'comprova:scopes': z.array(z.string()),
})

/** Item de `@context`: uma URL (string) ou um contexto JSON-LD inline (objeto). */
const ContextEntrySchema = z.union([z.string(), z.record(z.string(), z.unknown())])

export const VerifiableCredentialSchema = z.object({
  '@context': z.array(ContextEntrySchema).min(1),
  type: z.array(z.string()).min(1),
  issuer: z.string().min(1),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime().optional(),
  credentialSubject: z.object({
    id: z.string().min(1),
    type: z.array(z.string()).min(1),
    'comprova:docType': z.enum(['CPF', 'CNPJ']),
    'comprova:claim': ComprovaClaimSchema,
  }),
  evidence: z.array(ComprovaEvidenceSchema).min(1),
  'comprova:evidenceSetHash': HexSha256Schema,
  'comprova:result': ComprovaResultSchema,
  'comprova:policy': ComprovaPolicySchema,
  'comprova:algorithm': ComprovaAlgorithmSchema,
  'comprova:authorization': ComprovaAuthorizationSchema.optional(),
  'comprova:legalBasis': z.string().min(1),
})

export type VerifiableCredential = z.infer<typeof VerifiableCredentialSchema>
export type ComprovaEvidence = z.infer<typeof ComprovaEvidenceSchema>

export const SecuredVerifiableCredentialSchema = VerifiableCredentialSchema.extend({
  proof: DataIntegrityProofSchema,
})

export type SecuredVerifiableCredential = z.infer<typeof SecuredVerifiableCredentialSchema>

const addressOf = (
  target: AssertionPayload['claim']['target'],
): VerifiableCredential['credentialSubject']['comprova:claim']['comprova:address'] => ({
  ...(target.id === null ? {} : { id: target.id }),
  ...(target.building_key === null ? {} : { 'comprova:buildingKey': target.building_key }),
})

const evidenceOf = (observation: CredentialObservation): ComprovaEvidence => ({
  id: observation.id,
  type: [COMPROVA_EVIDENCE_TYPE],
  'comprova:checker': observation.checker,
  'comprova:checkerVersion': observation.checker_version,
  'comprova:stance': observation.stance,
  'comprova:strength': observation.strength,
  'comprova:confidence': observation.confidence,
  'comprova:source': observation.source,
  'comprova:observedAt': observation.observed_at,
  ...(observation.evidence_sha256 === null ? {} : { 'comprova:evidenceSha256': observation.evidence_sha256 }),
  'comprova:detail': observation.detail,
})

const explanationOf = (
  explanation: NonNullable<AssertionPayload['result']['explanation']>,
): NonNullable<VerifiableCredential['comprova:result']['comprova:explanation']> => ({
  'comprova:code': explanation.code,
  'comprova:summary': explanation.summary,
  'comprova:supportingEvidence': [...explanation.supporting_evidence],
  'comprova:contradictingEvidence': [...explanation.contradicting_evidence],
})

/**
 * Mapping interno → W3C (puro, determinístico). Campos ausentes (`null` no
 * modelo interno) são OMITIDOS no documento, e não materializados como `null`:
 * o VC é JSON-LD e um valor `null` não tem significado. A forma continua
 * determinística porque presença/ausência é função da assertion.
 */
export const toVerifiableCredential = (assertion: AssertionPayload): VerifiableCredential => ({
  '@context': context(),
  type: [VERIFIABLE_CREDENTIAL_TYPE, COMPROVA_CREDENTIAL_TYPE],
  issuer: assertion.issuer.id,
  validFrom: assertion.timestamps.created_at,
  validUntil: assertion.timestamps.expires_at,
  credentialSubject: {
    id: assertion.subject.id,
    type: [COMPROVA_SUBJECT_TYPE],
    'comprova:docType': assertion.subject.doc_type,
    'comprova:claim': {
      id: assertion.claim.id,
      type: [COMPROVA_CLAIM_TYPE],
      'comprova:claimType': assertion.claim.type,
      'comprova:subjectType': assertion.claim.subject_type,
      'comprova:targetType': assertion.claim.target.type,
      'comprova:address': addressOf(assertion.claim.target),
    },
  },
  evidence: assertion.evidence.observations.map(evidenceOf),
  'comprova:evidenceSetHash': assertion.evidence.set_hash,
  'comprova:result': {
    'comprova:verdict': assertion.result.verdict,
    'comprova:score': assertion.result.score,
    'comprova:confidence': assertion.result.confidence,
    ...(assertion.timestamps.completed_at === null
      ? {}
      : { 'comprova:completedAt': assertion.timestamps.completed_at }),
    ...(assertion.result.explanation === null
      ? {}
      : { 'comprova:explanation': explanationOf(assertion.result.explanation) }),
  },
  'comprova:policy': {
    'comprova:version': assertion.policy.version,
    'comprova:hash': assertion.policy.hash,
  },
  'comprova:algorithm': { 'comprova:scorerVersion': assertion.algorithm.scorer_version },
  ...(assertion.issuer.authorization === null
    ? {}
    : { 'comprova:authorization': { 'comprova:scopes': [...assertion.issuer.authorization.scopes] } }),
  'comprova:legalBasis': assertion.legal_basis,
})

/** W3C → observação interna, para recompor o `evidence_set_hash` no verifier. */
export const observationOfEvidence = (evidence: ComprovaEvidence): CredentialObservation => ({
  id: evidence.id,
  checker: evidence['comprova:checker'],
  checker_version: evidence['comprova:checkerVersion'],
  stance: evidence['comprova:stance'],
  strength: evidence['comprova:strength'],
  confidence: evidence['comprova:confidence'],
  source: evidence['comprova:source'],
  observed_at: evidence['comprova:observedAt'],
  evidence_sha256: evidence['comprova:evidenceSha256'] ?? null,
  detail: evidence['comprova:detail'],
})
