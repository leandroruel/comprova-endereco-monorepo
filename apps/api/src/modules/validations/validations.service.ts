import {
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  FISCAL_SOURCE_KIND,
  UPLOADED_DOCUMENT_CHECKER,
  UPLOADED_DOCUMENT_SOURCE,
} from '@comprova/core'
import { and, desc, eq, sql, withTenant, type Db, type DbTx } from '@comprova/db'
import * as t from '@comprova/db'
import { encryptSecret } from '../../shared/secretbox.js'
import { buildValidationProgress, type ValidationProgressVerification } from './validation-progress.js'

/** Normaliza valores de `jsonb_build_object` para string ISO (ou null). */
const jsonText = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
  }
  return null
}

const evidenceSummaryForClaim = async (
  tx: DbTx,
  claimId: string,
): Promise<{ supporting: number; contradicting: number; unknown: number }> => {
  const rows = await tx
    .select({ stance: t.claimEvidence.stance, count: sql<number>`count(*)::int` })
    .from(t.claimEvidence)
    .where(eq(t.claimEvidence.claimId, claimId))
    .groupBy(t.claimEvidence.stance)
  const byStance = new Map(rows.map((row) => [row.stance, row.count]))
  return {
    supporting: byStance.get('supports') ?? 0,
    contradicting: byStance.get('contradicts') ?? 0,
    unknown: byStance.get('unknown') ?? 0,
  }
}

// BAIXO-7: mesma representação de endereço usada pelo POST (fast path/replay),
// para que POST e GET devolvam o MESMO estado persistido. O `building_key` é
// serializado como `b64:<base64url>` — idêntico ao fast path.
const loadAddressSummary = async (
  tx: DbTx,
  addressId: string,
): Promise<{
  buildingKey: string
  country: string
  uf: string | null
  geoPrecision: 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE' | 'NONE'
} | null> => {
  const rows = await tx
    .select({
      buildingKey: t.canonicalAddress.buildingKey,
      countryCode: t.canonicalAddress.countryCode,
      uf: t.canonicalAddress.uf,
      geoPrecision: t.canonicalAddress.geoPrecision,
    })
    .from(t.canonicalAddress)
    .where(eq(t.canonicalAddress.addressId, addressId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return {
    buildingKey: `b64:${Buffer.from(row.buildingKey).toString('base64url')}`,
    country: row.countryCode,
    uf: row.uf,
    geoPrecision: row.geoPrecision,
  }
}

const verificationSummary = (value: unknown): ValidationProgressVerification | null => {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return {
    status: typeof record.status === 'string' ? record.status : '',
    document: typeof record.document === 'string' ? record.document : '',
  }
}

export const getValidationDetails = async (db: Db, tenantId: string, validationId: string) =>
  withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        validationId: t.validation.validationId,
        status: t.validation.status,
        verdict: t.validation.verdict,
        score: t.validation.score,
        confidence: t.validation.confidence,
        policyVersion: t.validation.policyVersion,
        explanation: t.validation.explanation,
        addressId: t.validation.addressId,
        fiscalReassessment: t.validation.fiscalReassessment,
        createdAt: t.validation.createdAt,
        expiresAt: t.validation.expiresAt,
      })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    const validation = rows[0]
    if (validation === undefined) return null

    const signals = await tx
      .select({
        checkerId: t.signal.checkerId,
        checkerVersion: t.signal.checkerVersion,
        stance: t.signal.stance,
        strength: t.signal.strength,
        confidence: t.signal.confidence,
        source: t.signal.source,
        observedAt: t.signal.observedAt,
        ttlSeconds: t.signal.ttlSeconds,
        detail: t.signal.detail,
        evidenceId: t.signal.evidenceId,
      })
      .from(t.signal)
      .where(eq(t.signal.validationId, validationId))
      .orderBy(t.signal.createdAt)

    // O claim e o resumo de observações tornam explícita a nova semântica
    // (validation → claim → claim_evidence) também na leitura (GET).
    const claimRows = await tx
      .select({
        claimId: t.claim.claimId,
        type: t.claim.type,
        subjectType: t.claim.subjectType,
        subjectId: t.claim.subjectId,
        targetType: t.claim.targetType,
        addressId: t.claim.addressId,
      })
      .from(t.claim)
      .where(eq(t.claim.validationId, validationId))
      .limit(1)
    const claim = claimRows[0] ?? null
    const evidenceSummary = claim === null ? null : await evidenceSummaryForClaim(tx, claim.claimId)

    // PR #74: presença do documento do cliente = recibo materializado (mesmo
    // predicado da listagem). NÃO se infere de `evidence_summary`, que existe
    // para qualquer claim — inclusive antes do intake do documento.
    const receiptRows =
      claim === null
        ? []
        : await tx
            .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
            .from(t.claimEvidence)
            .where(
              and(
                eq(t.claimEvidence.claimId, claim.claimId),
                eq(t.claimEvidence.tenantId, tenantId),
                eq(t.claimEvidence.source, CUSTOMER_DOCUMENT_INTAKE_SOURCE),
              ),
            )
            .limit(1)
    const hasCustomerDocument = receiptRows.length > 0

    // F1.3: a leitura corrente é a verificação materializada mais recente.
    // Versões anteriores permanecem no banco para auditoria, mas não são
    // sobrescritas (claim_evidence é imutável).
    const verificationRows =
      claim === null
        ? []
        : await tx
            .select({ detail: t.claimEvidence.detail })
            .from(t.claimEvidence)
            .where(
              and(
                eq(t.claimEvidence.claimId, claim.claimId),
                eq(t.claimEvidence.source, UPLOADED_DOCUMENT_SOURCE),
                eq(t.claimEvidence.checker, UPLOADED_DOCUMENT_CHECKER),
              ),
            )
            .orderBy(desc(t.claimEvidence.observedAt), desc(t.claimEvidence.createdAt))
            .limit(1)
    const evidenceVerification = verificationRows[0]?.detail.verification ?? null

    // Status da referência fiscal da análise corrente (F2.2b). Diz ao cliente
    // se uma consulta fiscal é esperada (`found`): o dashboard usa isso para
    // não encerrar o acompanhamento antes da consulta fiscal chegar — e para
    // concluir comprovantes sem QR normalmente. Sem PII (nunca a chave/URL).
    const analysisId = (evidenceVerification as { analysis_id?: unknown } | null)?.analysis_id
    const analysisRows =
      typeof analysisId === 'string'
        ? await tx
            .select({ result: t.evidenceAnalysis.result })
            .from(t.evidenceAnalysis)
            .where(
              and(eq(t.evidenceAnalysis.analysisId, analysisId), eq(t.evidenceAnalysis.tenantId, tenantId)),
            )
            .limit(1)
        : []
    const rawReference = (analysisRows[0]?.result as { fiscalReference?: { status?: unknown } } | undefined)
      ?.fiscalReference
    const fiscalReferenceStatus = typeof rawReference?.status === 'string' ? rawReference.status : null

    // F2: a leitura corrente da consulta fiscal é a observação mais recente
    // (mesma no-op de versão do F1.3; o histórico permanece para auditoria).
    const fiscalRows =
      claim === null
        ? []
        : await tx
            .select({ detail: t.claimEvidence.detail })
            .from(t.claimEvidence)
            .where(
              and(
                eq(t.claimEvidence.claimId, claim.claimId),
                eq(t.claimEvidence.source, FISCAL_SOURCE_KIND['nf3e']),
              ),
            )
            .orderBy(desc(t.claimEvidence.observedAt), desc(t.claimEvidence.createdAt))
            .limit(1)
    const fiscalVerification = fiscalRows[0]?.detail.verification ?? null

    // Progresso observável: a análise mais recente do artefato de intake é
    // consultada diretamente (não depende da F1.3 já ter materializado a
    // verificação), para que o dashboard veja "Lendo documento" e "Lendo QR
    // Code" enquanto o worker ainda está processando. A query não expõe o
    // resultado bruto: só status e a taxonomia controlada da referência.
    const latestAnalysisRows =
      claim === null
        ? []
        : await tx
            .select({
              status: t.evidenceAnalysis.status,
              result: t.evidenceAnalysis.result,
            })
            .from(t.claimEvidence)
            .innerJoin(
              t.evidenceArtifact,
              and(
                eq(t.evidenceArtifact.claimEvidenceId, t.claimEvidence.claimEvidenceId),
                eq(t.evidenceArtifact.tenantId, t.claimEvidence.tenantId),
              ),
            )
            .innerJoin(
              t.evidenceAnalysis,
              and(
                eq(t.evidenceAnalysis.artifactId, t.evidenceArtifact.artifactId),
                eq(t.evidenceAnalysis.tenantId, t.evidenceArtifact.tenantId),
              ),
            )
            .where(
              and(
                eq(t.claimEvidence.claimId, claim.claimId),
                eq(t.claimEvidence.source, CUSTOMER_DOCUMENT_INTAKE_SOURCE),
              ),
            )
            .orderBy(desc(t.evidenceAnalysis.createdAt))
            .limit(1)
    const latestAnalysis = latestAnalysisRows[0] ?? null
    const rawLatestResult = latestAnalysis?.result as
      | {
          fiscalReference?: { status?: unknown } | null
          document?: { status?: unknown } | null
        }
      | null
      | undefined
    const latestReferenceStatus =
      typeof rawLatestResult?.fiscalReference?.status === 'string'
        ? rawLatestResult.fiscalReference.status
        : null
    const latestDocumentStatus =
      typeof rawLatestResult?.document?.status === 'string' ? rawLatestResult.document.status : null

    const progress = buildValidationProgress({
      validationStatus: validation.status,
      fiscalReassessment: validation.fiscalReassessment,
      analysis:
        latestAnalysis === null
          ? null
          : {
              status: latestAnalysis.status,
              fiscalReferenceStatus: latestReferenceStatus,
              documentStatus: latestDocumentStatus,
            },
      evidenceVerification: verificationSummary(evidenceVerification),
      fiscalVerification: verificationSummary(fiscalVerification),
    })

    const address = validation.addressId === null ? null : await loadAddressSummary(tx, validation.addressId)

    return {
      validation,
      signals,
      claim,
      evidenceSummary,
      hasCustomerDocument,
      evidenceVerification,
      fiscalVerification,
      fiscalReferenceStatus,
      progress,
      address,
    }
  })

export interface ListValidationsQuery {
  readonly limit: number
  readonly offset: number
}

export interface ValidationListItem {
  readonly validationId: string
  readonly status: (typeof t.validation.$inferSelect)['status']
  readonly verdict: (typeof t.validation.$inferSelect)['verdict']
  readonly score: number | null
  readonly confidence: number | null
  readonly hasCustomerDocument: boolean
  readonly documentProcessing: boolean
  /** Referência externa do Holder associado (quando há solicitação vinculada). */
  readonly holderExternalReference: string | null
  /** Indica se o consentimento do Holder foi registrado para a solicitação vinculada. */
  readonly consentGranted: boolean
  readonly holderRequestId: string | null
  readonly holderRequestState: string | null
  readonly holderRequestCreatedAt: string | null
  readonly holderRequestExpiresAt: string | null
  readonly holderConsentAcceptedAt: string | null
  readonly holderDocumentsReceived: boolean
  readonly holderDocumentProcessingState: string | null
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface ValidationsListResult {
  readonly items: readonly ValidationListItem[]
  readonly total: number
}

/**
 * Listagem paginada de validações do tenant (dashboard do Verifier).
 *
 * Página e total vêm da MESMA declaração SQL (o total é subquery escalar no
 * próprio SELECT): sob READ COMMITTED, uma única declaração lê um único
 * snapshot — a página e o total nunca divergem (duas queries separadas
 * podiam ver commits diferentes entre elas). Quando a página é vazia (offset
 * além do total), o total é recomposto com um count dedicado — para página
 * vazia legítima de paginação não há página/total a confrontar.
 *
 * Ordenação estável por `created_at` (desc) + `validation_id` (desempate
 * determinístico). O estado da submissão documental é resolvido por EXISTS
 * sobre o recibo `customer_submitted_document` e o processamento do documento
 * pela existência de análise de intake (F1.2) não terminal — sem N+1 e sem
 * expor conteúdo de evidência. RLS + filtro explícito de tenant restringem a
 * leitura ao tenant autenticado.
 */
export const listValidations = async (
  db: Db,
  tenantId: string,
  query: ListValidationsQuery,
): Promise<ValidationsListResult> =>
  withTenant(db, tenantId, async (tx) => {
    const items = await tx
      .select({
        validationId: t.validation.validationId,
        status: t.validation.status,
        verdict: t.validation.verdict,
        score: t.validation.score,
        confidence: t.validation.confidence,
        createdAt: t.validation.createdAt,
        expiresAt: t.validation.expiresAt,
        hasCustomerDocument: sql<boolean>`EXISTS (
          SELECT 1
          FROM claim c
          JOIN claim_evidence ce
            ON ce.claim_id = c.claim_id
           AND ce.tenant_id = c.tenant_id
          WHERE c.validation_id = validation.validation_id
            AND c.tenant_id = validation.tenant_id
            AND ce.source = ${CUSTOMER_DOCUMENT_INTAKE_SOURCE}
        )`,
        documentProcessing: sql<boolean>`EXISTS (
          SELECT 1
          FROM claim c
          JOIN claim_evidence ce
            ON ce.claim_id = c.claim_id
           AND ce.tenant_id = c.tenant_id
          JOIN evidence_artifact a
            ON a.claim_evidence_id = ce.claim_evidence_id
           AND a.tenant_id = ce.tenant_id
          JOIN evidence_analysis ea
            ON ea.artifact_id = a.artifact_id
           AND ea.tenant_id = a.tenant_id
          WHERE c.validation_id = validation.validation_id
            AND c.tenant_id = validation.tenant_id
            AND ce.source = ${CUSTOMER_DOCUMENT_INTAKE_SOURCE}
            AND ea.status IN ('pending', 'analyzing')
        )`,
        holderRequest: sql<{
          externalReference: string | null
          requestId: string
          state: string
          createdAt: string
          expiresAt: string | null
          consentGranted: boolean
          consentAcceptedAt: string | null
          documentsReceived: boolean
          documentProcessingState: string | null
        } | null>`(
          SELECT jsonb_build_object(
            'externalReference', h.external_reference,
            'requestId', hir.id,
            'state', hir.state,
            'createdAt', hir.created_at,
            'expiresAt', hir.expires_at,
            'consentGranted', EXISTS (
              SELECT 1
              FROM holder_consent hc
              WHERE hc.holder_information_request_id = hir.id
                AND hc.tenant_id = hir.tenant_id
                AND hc.state = 'granted'
            ),
            'consentAcceptedAt', (
              SELECT hc.accepted_at
              FROM holder_consent hc
              WHERE hc.holder_information_request_id = hir.id
                AND hc.tenant_id = hir.tenant_id
                AND hc.state = 'granted'
              LIMIT 1
            ),
            'documentsReceived', EXISTS (
              SELECT 1
              FROM holder_information_request_document d
              WHERE d.holder_information_request_id = hir.id
                AND d.tenant_id = hir.tenant_id
                AND d.upload_state = 'stored'
                AND d.deleted_at IS NULL
            ),
            'documentProcessingState', (
              SELECT hsp.state
              FROM holder_submission_processing hsp
              WHERE hsp.holder_information_request_id = hir.id
                AND hsp.tenant_id = hir.tenant_id
              LIMIT 1
            )
          )
          FROM holder_information_request hir
          JOIN holder h ON h.holder_id = hir.holder_id AND h.tenant_id = hir.tenant_id
          WHERE hir.validation_id = validation.validation_id
            AND hir.tenant_id = validation.tenant_id
          ORDER BY hir.created_at DESC
          LIMIT 1
        )`,
        pageTotal: sql<number>`(SELECT count(*)::int FROM validation v2 WHERE v2.tenant_id = ${tenantId})`,
      })
      .from(t.validation)
      .where(eq(t.validation.tenantId, tenantId))
      .orderBy(desc(t.validation.createdAt), desc(t.validation.validationId))
      .limit(query.limit)
      .offset(query.offset)

    if (items[0] !== undefined) {
      // pageTotal vem do mesmo snapshot da página (subquery no mesmo SELECT).
      return {
        items: items.map((row) => {
          const holderRequest = (() => {
            const raw = row.holderRequest
            if (!raw) return null
            try {
              return typeof raw === 'string' ? JSON.parse(raw) : raw
            } catch {
              return null
            }
          })()
          return {
            validationId: row.validationId,
            status: row.status,
            verdict: row.verdict,
            score: row.score,
            confidence: row.confidence,
            hasCustomerDocument: row.hasCustomerDocument,
            documentProcessing: row.documentProcessing,
            holderExternalReference: holderRequest?.externalReference ?? null,
            consentGranted: holderRequest?.consentGranted ?? false,
            holderRequestId: holderRequest?.requestId ?? null,
            holderRequestState: holderRequest?.state ?? null,
            holderRequestCreatedAt: jsonText(holderRequest?.createdAt),
            holderRequestExpiresAt: jsonText(holderRequest?.expiresAt),
            holderConsentAcceptedAt: jsonText(holderRequest?.consentAcceptedAt),
            holderDocumentsReceived: holderRequest?.documentsReceived ?? false,
            holderDocumentProcessingState: holderRequest?.documentProcessingState ?? null,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
          }
        }),
        total: items[0].pageTotal,
      }
    }

    // Página vazia (offset além do total): recomponde o total para a UI.
    const [countRow] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(t.validation)
      .where(eq(t.validation.tenantId, tenantId))
    return { items: [], total: countRow?.total ?? 0 }
  })

export const setWorkflowId = async (
  db: Db,
  tenantId: string,
  validationId: string,
  workflowId: string,
): Promise<void> =>
  withTenant(db, tenantId, async (tx) => {
    await tx.update(t.validation).set({ workflowId }).where(eq(t.validation.validationId, validationId))
  })

export const contestValidation = async (
  db: Db,
  tenantId: string,
  apiKeyId: string | null,
  userId: string | null | undefined,
  validationId: string,
  reason: string,
  encryptionKey: string,
): Promise<boolean> =>
  withTenant(db, tenantId, async (tx) => {
    const exists = await tx
      .select({ validationId: t.validation.validationId })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
      .limit(1)
    if (exists.length === 0) return false

    if (apiKeyId === null && (userId === null || userId === undefined)) {
      throw new Error('validation.contested without authenticated userId')
    }

    await tx.insert(t.auditLog).values({
      tenantId,
      actor: apiKeyId !== null ? `api-key:${apiKeyId}` : `session:${userId}`,
      action: 'validation.contested',
      targetType: 'validation',
      targetId: validationId,
      details: {
        reason_enc: encryptSecret(encryptionKey, reason).toString('base64'),
        reason_length: reason.length,
      },
    })
    await tx.insert(t.outbox).values({
      aggregate: 'validation',
      aggregateId: validationId,
      eventType: 'validation.contested',
      payload: {
        tenant_id: tenantId,
        validation_id: validationId,
      },
    })
    return true
  })
