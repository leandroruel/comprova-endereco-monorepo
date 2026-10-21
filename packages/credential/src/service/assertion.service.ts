import { evidenceSetHash, type EvidenceSetEntry } from '@comprova/core'
import type {
  AssertionObservation,
  AssertionPayload,
  AssertionSource,
  CredentialObservation,
} from '../schema/assertion.schema.js'
import { deriveCredentialSubjectId } from './subject.service.js'

/**
 * Binding de evidência (FASE 5): converte uma observação da credencial no
 * formato do `evidence_set_hash`. Usa `evidence_sha256` (durável) e NUNCA
 * `evidence_id`/`s3_uri`, de modo que o conjunto continue verificável depois da
 * retenção do material físico.
 */
export const observationEntry = (observation: CredentialObservation): EvidenceSetEntry => ({
  id: observation.id,
  checker: observation.checker,
  checkerVersion: observation.checker_version,
  stance: observation.stance,
  strength: observation.strength,
  confidence: observation.confidence,
  source: observation.source,
  observedAt: observation.observed_at,
  evidenceSha256: observation.evidence_sha256,
  detail: observation.detail,
})

export const evidenceSetHashOfCredential = (observations: readonly CredentialObservation[]): string =>
  evidenceSetHash(observations.map(observationEntry))

/**
 * Scopes que podem ser publicados em `assertionAuthority`.
 *
 * O campo descreve a autoridade de VALIDAÇÃO sob a qual o issuer produziu a
 * asserção; ele não é uma permissão do titular da credencial. Scopes
 * administrativos, como `keys:write` (revogação de signing key), são
 * capacidades da API key/ator, não da credencial, e não dizem nada sobre a
 * emissão: ficam fora do documento. O snapshot completo continua persistido
 * em `validation.issuer_scopes` para auditoria (ADR-0017/ADR-0030).
 *
 * A lista é uma allowlist (não uma denylist): um scope operacional novo não
 * vaza para a credencial sem uma decisão explícita de contrato.
 */
export const ASSERTION_AUTHORITY_SCOPES = ['validate:read', 'validate:write'] as const

const ASSERTION_AUTHORITY_SCOPE_SET: ReadonlySet<string> = new Set(ASSERTION_AUTHORITY_SCOPES)

/**
 * Projeta o snapshot de autoridade da API key no subconjunto que pertence à
 * credencial. Não altera o snapshot persistido: a filtragem acontece somente
 * no mapping para o documento assinado.
 */
export const assertionAuthorityScopes = (issuerScopes: readonly string[] | null): readonly string[] | null =>
  issuerScopes === null ? null : issuerScopes.filter((scope) => ASSERTION_AUTHORITY_SCOPE_SET.has(scope))

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
 * Normaliza a assertion de domínio já carregada (FASE 2/9). Puro: não acessa
 * banco. Recusa emitir credencial parcial — resultado incompleto, bindings
 * ausentes, `completed_at` ausente (não há como declarar `validFrom` sem
 * presumir), janela de validade vazia/invertida (`completed_at >= validUntil`)
 * ou `evidence_set_hash` incoerente com o conjunto de observações abortam a
 * emissão.
 *
 * As observações e os arrays de explicação são ordenados antes de montar o
 * payload, de modo que `mesma assertion → mesmos bytes`, independentemente da
 * ordem devolvida pelo PostgreSQL.
 *
 * O `issuerId` (URL do issuer) entra em dois lugares do payload: como `issuer`
 * do documento e como namespace do `credentialSubject.id` (`subject.service.ts`).
 * O `proof.created` NÃO é derivado daqui: ele é o instante real da assinatura.
 */
export const buildAssertion = (source: AssertionSource, issuerId: string): AssertionPayload => {
  const v = source.validation

  if (v.verdict === null || v.score === null || v.confidence === null) {
    throw new Error('validation result is incomplete; refusing to emit a partial credential')
  }
  if (v.policyHash === null || v.scorerVersion === null || v.evidenceSetHash === null) {
    throw new Error('validation bindings (policy_hash/scorer_version/evidence_set_hash) are missing')
  }
  // `completed_at` é o início da validade da informação certificada (ADR-0024
  // §5). Quando ele falta (registro anterior ao preenchimento do campo), o
  // instante real da conclusão é DESCONHECIDO: presumir `created_at` afirmaria
  // válido o que ainda não existia, então a emissão é recusada explicitamente.
  const completedAt = v.completedAt
  if (completedAt === null) {
    throw new Error(
      'validation has no completion timestamp (completed_at); refusing to guess when the result started to be valid',
    )
  }
  // Janela não vazia: `validFrom < validUntil` (VC 2.0 §4.9). `validUntil` é o
  // horizonte da CREDENCIAL (policy + TTL das evidências), não `expires_at`
  // (retenção). A emissão não estende esse horizonte: uma validação que concluiu
  // no ou depois dele não pode virar credencial com janela vazia/invertida.
  const validUntil = v.validUntil ?? v.expiresAt
  if (completedAt.getTime() >= validUntil.getTime()) {
    throw new Error(
      `validation concluded at ${completedAt.toISOString()} at or after its validity limit (${validUntil.toISOString()}); refusing to emit a credential with an empty or inverted window`,
    )
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

  // `issuerScopes` é o snapshot COMPLETO da autoridade da API key (auditoria).
  // A credencial publica somente os scopes que descrevem a autoridade de
  // validação; capacidades administrativas não são declarações da credencial.
  const authorityScopes = assertionAuthorityScopes(v.issuerScopes)

  return {
    format: 'comprova-assertion-v1',
    issuer: {
      id: issuerId,
      authority: authorityScopes === null ? null : { scopes: [...authorityScopes] },
    },
    subject: {
      id: deriveCredentialSubjectId({
        issuerId,
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
        type: source.claim.targetType,
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
      completed_at: completedAt.toISOString(),
      expires_at: v.expiresAt.toISOString(),
      valid_until: validUntil.toISOString(),
    },
  }
}
