import * as t from '@comprova/db'
import { eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import {
  buildCredential,
  localIssuer,
  type AssertionSource,
  type SecuredVerifiableCredential,
  type Signer,
} from '@comprova/credential'

/**
 * Fronteira de acesso ao PostgreSQL do builder de credencial (FASE 9). Carrega
 * o grafo da assertion já persistida (validation → claim → claim_evidence →
 * subject) para o formato "plain" de `AssertionSource`. Nenhuma tabela fora
 * desse grafo é consultada. A camada `@comprova/credential` é pura.
 *
 * Elegibilidade (FASE 9/10): só emite para `status = 'completed'` com resultado
 * completo, bindings presentes, o instante de conclusão registrado
 * (`completed_at`) e janela de validade não vazia (`completed_at < expires_at`).
 * NÃO emite silenciosamente para `partial`, NÃO presume `created_at` como
 * conclusão quando `completed_at` falta, e NÃO estende `expires_at` para caber
 * na credencial: um registro sem timestamp de conclusão falha com
 * `COMPLETION_TIME_MISSING` e um que concluiu fora do prazo, com
 * `VALIDITY_WINDOW_INVALID`.
 */

export type CredentialIssuanceFailure =
  | 'VALIDATION_NOT_FOUND'
  | 'VALIDATION_NOT_FINAL'
  | 'COMPLETION_TIME_MISSING'
  | 'VALIDITY_WINDOW_INVALID'
  | 'CLAIM_MISSING'
  | 'SUBJECT_MISSING'
  | 'EVIDENCE_MISSING'

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
    // `completed_at` é o `validFrom` do documento (ADR-0024 §5). Faltando ele
    // (registro anterior ao preenchimento do campo), a data de conclusão é
    // DESCONHECIDA: usar `created_at` afirmaria válido o que ainda não existia.
    if (v.completedAt === null) {
      throw new CredentialIssuanceError(
        'COMPLETION_TIME_MISSING',
        `validation ${validationId} has no completion timestamp (completed_at); refusing to guess when the result started to be valid`,
      )
    }
    // Janela não vazia: `validFrom = completed_at` e `validUntil = expires_at`
    // (ADR-0024 §5). Quando a análise concluiu no ou depois do horizonte
    // persistido, a credencial nasceria vazia/expirada — e `expires_at` é o
    // horizonte de retenção, que a emissão não estende (a política de 30 dias é
    // decisão de produto, não desta fronteira).
    if (v.completedAt.getTime() >= v.expiresAt.getTime()) {
      throw new CredentialIssuanceError(
        'VALIDITY_WINDOW_INVALID',
        `validation ${validationId} concluded at ${v.completedAt.toISOString()} at or after its validity limit (${v.expiresAt.toISOString()}); refusing to emit an expired credential`,
      )
    }

    const cRows = await tx
      .select({
        claimId: t.claim.claimId,
        type: t.claim.type,
        subjectType: t.claim.subjectType,
        targetType: t.claim.targetType,
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
        targetType: claim.targetType,
        addressId: claim.addressId,
      },
      addressBuildingKey:
        buildingKey === undefined ? null : `b64:${Buffer.from(buildingKey).toString('base64url')}`,
      observations: oRows,
    }
  })

export interface IssueCredentialDeps {
  /**
   * Origem HTTPS controlada pelo projeto (`CREDENTIAL_ISSUER_ORIGIN`). O `id` do
   * issuer é derivado dela + tenant, então o caller não escolhe o issuer: não
   * existe caminho para atribuir a assertion de um tenant ao issuer de outro.
   */
  readonly issuerOrigin: string
  /** Chave usada para assinar (fragmento do `proof.verificationMethod`). */
  readonly keyId: string
  readonly signer: Signer
  /**
   * Relógio da emissão (`proof.created` = momento real da prova). Injetável para
   * testes; default: o relógio do sistema.
   */
  readonly now?: () => Date
}

/** `validation_id → carrega o grafo → payload → canonicalização → assinatura → credencial`. */
export const issueCredential = async (
  db: Db,
  tenantId: string,
  validationId: string,
  deps: IssueCredentialDeps,
): Promise<SecuredVerifiableCredential> => {
  // O issuer é derivado do MESMO tenant que escopa a leitura (RLS): uma
  // validation de outro tenant nem é encontrada (VALIDATION_NOT_FOUND).
  const issuer = localIssuer(deps.issuerOrigin, tenantId, deps.keyId)

  const source = await loadAssertionSource(db, tenantId, validationId)
  return buildCredential(source, { issuer, signer: deps.signer, now: deps.now })
}
