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
 *  - `@context`, `type`, `issuer`, `validFrom` (§4.6/§4.10), `validUntil`;
 *  - `credentialSubject` (§4.8);
 *  - `evidence` (§5.6) — cada evidência tem `id` (opcional) e `type`
 *    (obrigatório);
 *  - `proof` (Data Integrity 1.0 §2.1).
 *
 * Todo `id` do documento é uma URL (§4.4): os identificadores internos são
 * UUIDs e aparecem como `urn:uuid:<uuid>` (o próprio exemplo normativo da spec,
 * e o formato usado no vetor B.3). O domínio continua com UUIDs; a conversão
 * para URL/IRI acontece só neste mapping e é desfeita em `observationOfEvidence`
 * para que o `evidence_set_hash` continue sendo o hash dos UUIDs do domínio.
 * `issuer`, `credentialSubject.id` e `proof.verificationMethod` são URLs HTTPS
 * sob a origem configurada do projeto (`issuer.ts`), nunca esquemas inventados.
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

const URN_UUID_PREFIX = 'urn:uuid:'

/**
 * Identificador de recurso no documento: uma URL. O Data Model 2.0 (§4.4) exige
 * que `id` seja uma única URL — um UUID nu é um IRI relativo e não é
 * interoperável —, e a spec exemplifica com `urn:uuid:`.
 */
export type UrnUuid = `urn:uuid:${string}`
export const UrnUuidSchema = z.templateLiteral([URN_UUID_PREFIX, z.uuid()])
export const urnUuidOf = (uuid: string): UrnUuid => `${URN_UUID_PREFIX}${uuid}`
/** Inverso de `urnUuidOf`. O schema acima garante o prefixo na entrada. */
export const uuidOfUrn = (urn: UrnUuid): string => urn.slice(URN_UUID_PREFIX.length)

/** `@context` do documento: o contexto base da VC 2.0 + o prefixo Comprova. */
const context = (): [typeof VC_CONTEXT_URL, { comprova: typeof COMPROVA_CONTEXT_URL }] => [
  VC_CONTEXT_URL,
  { comprova: COMPROVA_CONTEXT_URL },
]

const ComprovaAddressSchema = z.object({
  id: UrnUuidSchema.optional(),
  'comprova:buildingKey': z.string().min(1).optional(),
})

const ComprovaClaimSchema = z.object({
  id: UrnUuidSchema,
  type: z.array(z.string()).min(1),
  'comprova:claimType': z.enum(['business_registered_address', 'address_exists']),
  'comprova:subjectType': z.enum(['organization', 'person']),
  /** `claim.target_type` do domínio. */
  'comprova:targetType': z.enum(['address']),
  'comprova:address': ComprovaAddressSchema,
})

const ComprovaEvidenceSchema = z.object({
  id: UrnUuidSchema,
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
  'comprova:supportingEvidence': z.array(UrnUuidSchema),
  'comprova:contradictingEvidence': z.array(UrnUuidSchema),
})

const ComprovaResultSchema = z.object({
  'comprova:verdict': z.string().min(1),
  'comprova:score': z.number(),
  'comprova:confidence': z.number(),
  /**
   * `validation.completed_at` (o mesmo instante de `validFrom`). Opcional no
   * schema por tolerância de leitura: o emissor sempre o escreve, mas ele é
   * proveniência descritiva — a verificação temporal usa `validFrom`.
   */
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
  ...(target.id === null ? {} : { id: urnUuidOf(target.id) }),
  ...(target.building_key === null ? {} : { 'comprova:buildingKey': target.building_key }),
})

const evidenceOf = (observation: CredentialObservation): ComprovaEvidence => ({
  id: urnUuidOf(observation.id),
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
  'comprova:supportingEvidence': explanation.supporting_evidence.map(urnUuidOf),
  'comprova:contradictingEvidence': explanation.contradicting_evidence.map(urnUuidOf),
})

/**
 * `validFrom` (VC Data Model 2.0 §4.10) é o início da validade da informação
 * certificada — não a data de emissão da prova.
 *
 * A informação certificada é o VEREDITO da validation: ele passa a existir
 * quando a análise é concluída, e é isso que `completed_at` registra (o fluxo
 * rápido preenche no fim da requisição; o deep path, ao concluir o worker). Por
 * isso `validFrom` é `completed_at` — nunca `created_at`, que é o instante em
 * que a REQUISIÇÃO começou, antes da Receita, do enriquecimento e dos checkers,
 * e que declararia válido o que ainda não existia. Sem `completed_at` o início
 * da validade é desconhecido e `buildAssertion` recusa emitir (ADR-0024 §5).
 *
 * A emissão (`proof.created`) NÃO entra nesta conta: reemitir a mesma
 * validation em outro momento não pode deslocar o início da validade daquilo
 * que a credencial afirma sobre o passado.
 */
const validFromOf = (timestamps: AssertionPayload['timestamps']): string => timestamps.completed_at

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
  validFrom: validFromOf(assertion.timestamps),
  validUntil: assertion.timestamps.expires_at,
  credentialSubject: {
    id: assertion.subject.id,
    type: [COMPROVA_SUBJECT_TYPE],
    'comprova:docType': assertion.subject.doc_type,
    'comprova:claim': {
      id: urnUuidOf(assertion.claim.id),
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
    // Sempre presente: a emissão exige `completed_at` (ver `buildAssertion`).
    'comprova:completedAt': assertion.timestamps.completed_at,
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
  id: uuidOfUrn(evidence.id),
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
