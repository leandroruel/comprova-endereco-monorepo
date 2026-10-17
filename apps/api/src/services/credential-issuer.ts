import * as t from '@comprova/db'
import { eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import {
  buildCredential,
  type AssertionSource,
  type Credential,
  type IssuerIdentity,
  type Signer,
} from '@comprova/credential'

/**
 * Fronteira de acesso ao PostgreSQL do builder de credencial (FASE 9). Carrega
 * o grafo da assertion já persistida (validation → claim → claim_evidence →
 * subject) para o formato "plain" de `AssertionSource`. Nenhuma tabela fora
 * desse grafo é consultada. A camada `@comprova/credential` é pura.
 *
 * Elegibilidade (FASE 9/10): só emite para `status = 'completed'` com resultado
 * completo e bindings presentes. NÃO emite silenciosamente para `partial`.
 */

export type CredentialIssuanceFailure =
  'VALIDATION_NOT_FOUND' | 'VALIDATION_NOT_FINAL' | 'CLAIM_MISSING' | 'SUBJECT_MISSING' | 'EVIDENCE_MISSING'

export class CredentialIssuanceError extends Error {
  readonly failure: CredentialIssuanceFailure

  constructor(failure: CredentialIssuanceFailure, message: string) {
    super(message)
    this.name = 'CredentialIssuanceError'
    this.failure = failure
  }
}

type StoredExplanation = {
  summary?: string
  code?: string
  supporting_evidence?: string[]
  contradicting_evidence?: string[]
} | null

const toExplanation = (explanation: StoredExplanation): AssertionSource['validation']['explanation'] =>
  explanation === null
    ? null
    : {
        code: explanation.code ?? '',
        summary: explanation.summary ?? '',
        supporting_evidence: explanation.supporting_evidence ?? [],
        contradicting_evidence: explanation.contradicting_evidence ?? [],
      }

export const loadAssertionSource = async (
  db: Db,
  tenantId: string,
  validationId: string,
): Promise<AssertionSource> =>
  withTenant(db, tenantId, async (tx) => {
    const vRows = await tx
      .select({
        validationId: t.validation.validationId,
        subjectId: t.validation.subjectId,
        status: t.validation.status,
        verdict: t.validation.verdict,
        score: t.validation.score,
        confidence: t.validation.confidence,
        policyVersion: t.validation.policyVersion,
        policyHash: t.validation.policyHash,
        scorerVersion: t.validation.scorerVersion,
        evidenceSetHash: t.validation.evidenceSetHash,
        legalBasis: t.validation.legalBasis,
        issuerScopes: t.validation.issuerScopes,
        explanation: t.validation.explanation,
        createdAt: t.validation.createdAt,
        completedAt: t.validation.completedAt,
        expiresAt: t.validation.expiresAt,
      })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    const v = vRows[0]
    if (v === undefined) {
      throw new CredentialIssuanceError(
        'VALIDATION_NOT_FOUND',
        `validation ${validationId} not found for this tenant`,
      )
    }
    if (v.status !== 'completed' || v.verdict === null || v.score === null || v.confidence === null) {
      throw new CredentialIssuanceError(
        'VALIDATION_NOT_FINAL',
        `validation ${validationId} is not final (status=${v.status}); refusing to emit a partial credential`,
      )
    }

    const cRows = await tx
      .select({
        claimId: t.claim.claimId,
        type: t.claim.type,
        subjectType: t.claim.subjectType,
        addressId: t.claim.addressId,
      })
      .from(t.claim)
      .where(eq(t.claim.validationId, validationId))
      .limit(1)
    const claim = cRows[0]
    if (claim === undefined) {
      throw new CredentialIssuanceError('CLAIM_MISSING', `validation ${validationId} has no claim`)
    }

    const sRows = await tx
      .select({ docType: t.subject.docType, docHmac: t.subject.docHmac })
      .from(t.subject)
      .where(eq(t.subject.subjectId, v.subjectId))
      .limit(1)
    const subject = sRows[0]
    if (subject === undefined) {
      throw new CredentialIssuanceError('SUBJECT_MISSING', `subject ${v.subjectId} not found`)
    }

    const oRows = await tx
      .select({
        id: t.claimEvidence.claimEvidenceId,
        checker: t.claimEvidence.checker,
        checkerVersion: t.claimEvidence.checkerVersion,
        stance: t.claimEvidence.stance,
        strength: t.claimEvidence.strength,
        confidence: t.claimEvidence.confidence,
        source: t.claimEvidence.source,
        observedAt: t.claimEvidence.observedAt,
        evidenceSha256: t.claimEvidence.evidenceSha256,
        detail: t.claimEvidence.detail,
      })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, claim.claimId))
    if (oRows.length === 0) {
      throw new CredentialIssuanceError('EVIDENCE_MISSING', `claim ${claim.claimId} has no claim_evidence`)
    }

    const addressRows =
      claim.addressId === null
        ? []
        : await tx
            .select({ buildingKey: t.canonicalAddress.buildingKey })
            .from(t.canonicalAddress)
            .where(eq(t.canonicalAddress.addressId, claim.addressId))
            .limit(1)
    const buildingKey = addressRows[0]?.buildingKey

    return {
      tenantId,
      validation: {
        id: v.validationId,
        verdict: v.verdict,
        score: v.score,
        confidence: v.confidence,
        policyVersion: v.policyVersion,
        policyHash: v.policyHash,
        scorerVersion: v.scorerVersion,
        evidenceSetHash: v.evidenceSetHash,
        legalBasis: v.legalBasis,
        issuerScopes: v.issuerScopes,
        explanation: toExplanation(v.explanation),
        createdAt: v.createdAt,
        completedAt: v.completedAt,
        expiresAt: v.expiresAt,
      },
      subject: { docType: subject.docType, docHmac: subject.docHmac },
      claim: {
        id: claim.claimId,
        type: claim.type,
        subjectType: claim.subjectType,
        addressId: claim.addressId,
      },
      addressBuildingKey:
        buildingKey === undefined ? null : `b64:${Buffer.from(buildingKey).toString('base64url')}`,
      observations: oRows,
    }
  })

export interface IssueCredentialDeps {
  readonly issuer: IssuerIdentity
  readonly signer: Signer
}

/** `validation_id → carrega o grafo → payload → canonicalização → assinatura → credencial`. */
export const issueCredential = async (
  db: Db,
  tenantId: string,
  validationId: string,
  deps: IssueCredentialDeps,
): Promise<Credential> => {
  const source = await loadAssertionSource(db, tenantId, validationId)
  return buildCredential(source, deps)
}
