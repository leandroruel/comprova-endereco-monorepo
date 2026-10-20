import type { AssertionPayload, AssertionSource, CredentialObservation } from '../schema/assertion.schema.js'
import {
  COMPROVA_CLAIM_TYPE,
  COMPROVA_CONTEXT_URL,
  COMPROVA_CREDENTIAL_TYPE,
  COMPROVA_EVIDENCE_TYPE,
  COMPROVA_SUBJECT_TYPE,
  urnUuidOf,
  uuidOfUrn,
  VC_CONTEXT_URL,
  VERIFIABLE_CREDENTIAL_TYPE,
  type ComprovaEvidence,
  type SecuredVerifiableCredential,
  type VerifiableCredential,
} from '../schema/credential.schema.js'
import type { IssuerIdentity } from '../schema/issuer.schema.js'
import { ASSERTION_METHOD } from '../schema/proof.schema.js'
import { CREDENTIAL_STATUS_TYPE } from '../schema/status.schema.js'
import { buildAssertion } from './assertion.service.js'
import { verificationMethodOf } from './issuer.service.js'
import { createDataIntegrityProof } from './proof.service.js'
import type { Signer } from './signer.service.js'
import { credentialIdOf, credentialStatusUrlOf, credentialUrlOf } from './status.service.js'

/**
 * Mapping do modelo interno da Comprova (`AssertionPayload`) para o documento
 * W3C (VC Data Model 2.0) e emissão da credencial.
 *
 *   AssertionSource → AssertionPayload (interno)
 *                   → VerifiableCredential (W3C)
 *                   → DataIntegrityProof (eddsa-jcs-2022)
 *
 * A forma do documento está em `schema/credential.schema.ts`; aqui ficam a
 * conversão, os codecs de `urn:uuid:` e o caso de uso de emissão.
 */

export interface BuildCredentialDeps {
  readonly issuer: IssuerIdentity
  readonly signer: Signer
  /**
   * Identificador público já calculado pelo chamador. Quando omitido, é
   * derivado deterministicamente de `issuer.id + validation.id` (ADR-0027).
   * Passá-lo explicitamente garante que a linha de status criada pela API use
   * EXATAMENTE o mesmo id que entrou no documento assinado.
   */
  readonly credentialId?: string
  /**
   * Relógio da emissão. `proof.created` é o momento REAL em que a prova
   * criptográfica é criada (Data Integrity 1.0 §2.1.1) — nunca um timestamp
   * histórico da validation (ADR-0024 §4). Injetável para testes
   * determinísticos; default: `() => new Date()`.
   */
  readonly now?: () => Date
}

/** `@context` do documento: o contexto base da VC 2.0 + o prefixo Comprova. */
const context = (): [typeof VC_CONTEXT_URL, { comprova: typeof COMPROVA_CONTEXT_URL }] => [
  VC_CONTEXT_URL,
  { comprova: COMPROVA_CONTEXT_URL },
]

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
 * `validFrom` (VC Data Model 2.0 §4.9) é o início da validade da informação
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
export const toVerifiableCredential = (
  assertion: AssertionPayload,
  credentialId: string,
): VerifiableCredential => ({
  '@context': context(),
  type: [VERIFIABLE_CREDENTIAL_TYPE, COMPROVA_CREDENTIAL_TYPE],
  id: credentialUrlOf(assertion.issuer.id, credentialId),
  issuer: assertion.issuer.id,
  validFrom: validFromOf(assertion.timestamps),
  validUntil: assertion.timestamps.valid_until,
  credentialStatus: {
    id: credentialStatusUrlOf(assertion.issuer.id, credentialId),
    type: CREDENTIAL_STATUS_TYPE,
  },
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

/**
 * `AssertionSource → assertion interna → Verifiable Credential (W3C 2.0) →
 * Data Integrity proof (eddsa-jcs-2022)`. Puro (não acessa banco); o `signer` e
 * a identidade do issuer entram por dependência.
 *
 * O documento (sem `proof`) é determinístico em função da assertion. O proof
 * NÃO é: `created` é o instante real da assinatura. Duas emissões da mesma
 * validation produzem documentos iguais e provas diferentes — reaproveitar o
 * instante da primeira é uma decisão explícita de quem chama (`now`), não um
 * efeito de a camada "adivinhar" o tempo a partir da validation (ADR-0024 §4).
 */
export const buildCredential = async (
  source: AssertionSource,
  deps: BuildCredentialDeps,
): Promise<SecuredVerifiableCredential> => {
  const credentialId = deps.credentialId ?? credentialIdOf(deps.issuer.id, source.validation.id)
  const credential = toVerifiableCredential(buildAssertion(source, deps.issuer.id), credentialId)

  const proof = await createDataIntegrityProof(credential, {
    verificationMethod: verificationMethodOf(deps.issuer),
    proofPurpose: ASSERTION_METHOD,
    created: (deps.now ?? (() => new Date()))().toISOString(),
    signer: deps.signer,
  })

  return { ...credential, proof }
}
