import type {
  AssertionObservation,
  AssertionPayload,
  AssertionSource,
  Credential,
  CredentialObservation,
} from './assertion.js'
import { canonicalAssertionBytes } from './canonical.js'
import { evidenceSetHashOfCredential } from './evidence.js'
import type { IssuerIdentity } from './issuer.js'
import type { Signer } from './signer.js'
import { deriveCredentialSubjectId } from './subject.js'

export interface BuildCredentialDeps {
  readonly issuer: IssuerIdentity
  readonly signer: Signer
}

const byId = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

const hexOf = (value: Uint8Array | null): string | null =>
  value === null ? null : Buffer.from(value).toString('hex')

const toCredentialObservation = (o: AssertionObservation): CredentialObservation => ({
  id: o.id,
  checker: o.checker,
  checker_version: o.checkerVersion,
  stance: o.stance,
  strength: o.strength,
  confidence: o.confidence,
  source: o.source,
  observed_at: o.observedAt.toISOString(),
  evidence_sha256: hexOf(o.evidenceSha256),
  detail: o.detail,
})

/**
 * Constrói (mas não persiste) a credencial de uma assertion já carregada
 * (FASE 9). Puro: não acessa banco. Recusa emitir credencial parcial — resultado
 * incompleto, bindings ausentes ou `evidence_set_hash` incoerente com o conjunto
 * de observações abortam a emissão.
 *
 * As observações e os arrays de explicação são ordenados antes de montar o
 * payload, de modo que `mesma assertion → mesmos bytes`, independentemente da
 * ordem devolvida pelo PostgreSQL.
 */
export const buildCredential = async (
  source: AssertionSource,
  deps: BuildCredentialDeps,
): Promise<Credential> => {
  const v = source.validation

  if (v.verdict === null || v.score === null || v.confidence === null) {
    throw new Error('validation result is incomplete; refusing to emit a partial credential')
  }
  if (v.policyHash === null || v.scorerVersion === null || v.evidenceSetHash === null) {
    throw new Error('validation bindings (policy_hash/scorer_version/evidence_set_hash) are missing')
  }

  const observations = [...source.observations].sort(byId).map(toCredentialObservation)

  const recomputed = evidenceSetHashOfCredential(observations)
  if (recomputed !== v.evidenceSetHash) {
    throw new Error('evidence_set_hash mismatch between the persisted validation and its claim_evidence set')
  }

  const summary = {
    supporting: observations.filter((o) => o.stance === 'supports').length,
    contradicting: observations.filter((o) => o.stance === 'contradicts').length,
    unknown: observations.filter((o) => o.stance === 'unknown').length,
  }

  const payload: AssertionPayload = {
    format: 'comprova-assertion-v1',
    issuer: {
      id: deps.issuer.id,
      authorization: v.issuerScopes === null ? null : { scopes: [...v.issuerScopes] },
    },
    subject: {
      id: deriveCredentialSubjectId({
        tenantId: source.tenantId,
        docType: source.subject.docType,
        docHmac: source.subject.docHmac,
      }),
      doc_type: source.subject.docType,
    },
    claim: {
      id: source.claim.id,
      type: source.claim.type,
      subject_type: source.claim.subjectType,
      target: {
        type: 'address',
        id: source.claim.addressId,
        building_key: source.addressBuildingKey,
      },
    },
    evidence: {
      set_hash: v.evidenceSetHash,
      summary,
      observations,
    },
    policy: { version: v.policyVersion, hash: v.policyHash },
    algorithm: { scorer_version: v.scorerVersion },
    result: {
      status: 'completed',
      verdict: v.verdict,
      score: v.score,
      confidence: v.confidence,
      explanation:
        v.explanation === null
          ? null
          : {
              code: v.explanation.code,
              summary: v.explanation.summary,
              supporting_evidence: [...v.explanation.supporting_evidence].sort(),
              contradicting_evidence: [...v.explanation.contradicting_evidence].sort(),
            },
    },
    legal_basis: v.legalBasis,
    timestamps: {
      created_at: v.createdAt.toISOString(),
      completed_at: v.completedAt === null ? null : v.completedAt.toISOString(),
      expires_at: v.expiresAt.toISOString(),
    },
  }

  const signature = await deps.signer.sign(canonicalAssertionBytes(payload))

  return {
    payload,
    proof: {
      type: 'Ed25519Signature',
      key_id: deps.issuer.keyId,
      signature: Buffer.from(signature).toString('base64url'),
    },
  }
}
