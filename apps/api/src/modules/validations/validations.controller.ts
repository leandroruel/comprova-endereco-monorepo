import { createHash } from 'node:crypto'
import {
  EvidenceVerificationDtoSchema,
  FiscalReassessmentStateSchema,
  FiscalReferenceStatusSchema,
  FiscalVerificationDtoSchema,
  PROBLEM_CONTENT_TYPE,
  problem,
  problems,
  type ValidationDto,
} from '@comprova/contracts'
import { isValidDocument, type AddressComponents } from '@comprova/core'
import type { Db } from '@comprova/db'
import type { FastifyReply } from 'fastify'
import type { CreateValidationRequest } from '@comprova/contracts'
import {
  runFastPath,
  type FastPathDeps,
  type FastPathRequest,
  type FastPathResult,
} from '../../services/fastpath.js'
import { startDeepWorkflow, type DeepTriggerDeps } from '../../services/deep-trigger.js'
import {
  CredentialIssuanceError,
  issueCredential,
  type CredentialIssuerDeps,
} from '../../services/credential-issuer.js'
import { contestValidation, getValidationDetails, setWorkflowId } from './validations.service.js'

export interface ValidationControllerDeps {
  readonly db: Db
  readonly fastPath: FastPathDeps
  readonly deepTrigger: DeepTriggerDeps
  readonly vlmEnabled: boolean
  /** Assinatura/identidade do issuer resolvidas no boot (`app.ts`). */
  readonly credentialIssuer: CredentialIssuerDeps
}

const summaryOf = (explanation: { summary?: string } | null): string | null => {
  const summary = explanation?.summary
  return typeof summary === 'string' ? summary : null
}

const explanationDetailFromStored = (
  explanation: {
    summary?: string
    code?: string
    supporting_evidence?: string[]
    contradicting_evidence?: string[]
  } | null,
): ValidationDto['explanation_detail'] => {
  if (explanation === null || typeof explanation.code !== 'string') return null
  return {
    code: explanation.code,
    message: explanation.summary ?? '',
    supporting_evidence: explanation.supporting_evidence ?? [],
    contradicting_evidence: explanation.contradicting_evidence ?? [],
  }
}

const dtoFromResult = (result: FastPathResult): ValidationDto => ({
  validation_id: result.validationId,
  status: result.status,
  verdict: result.verdict,
  confidence: result.confidence,
  score: result.score,
  policy_version: result.policyVersion,
  address:
    result.address === null
      ? null
      : {
          building_key: result.address.buildingKey,
          country: result.address.country,
          uf: result.address.uf,
          geo_precision: 'NONE',
        },
  signals: result.signals.map((signal) => ({
    checker: signal.checkerId,
    checker_version: signal.checkerVersion,
    stance: signal.stance,
    strength: signal.strength,
    confidence: signal.confidence,
    source: signal.source,
    observed_at: signal.observedAt,
    ttl_seconds: signal.ttlSeconds,
    detail: signal.detail,
    evidence_id: signal.evidenceId ?? null,
  })),
  claim: result.claim
    ? {
        id: result.claim.id,
        type: result.claim.type as 'business_registered_address' | 'address_exists',
        subject: {
          type: result.claim.subject.type as 'organization' | 'person',
          id: result.claim.subject.refId,
        },
        target: {
          type: 'address' as const,
          id: result.claim.target.refId,
        },
      }
    : null,
  evidence_summary: result.evidenceSummary ?? null,
  explanation: result.explanation,
  explanation_detail: result.explanationDetail
    ? {
        code: result.explanationDetail.code,
        message: result.explanationDetail.message,
        supporting_evidence: [...result.explanationDetail.supportingEvidenceIds],
        contradicting_evidence: [...result.explanationDetail.contradictingEvidenceIds],
      }
    : null,
  created_at: result.createdAt.toISOString(),
  expires_at: result.expiresAt.toISOString(),
})

const addressComponentsFromDto = (dto: {
  readonly tipo_logradouro?: string
  readonly logradouro: string
  readonly numero?: string
  readonly complemento?: string
  readonly bairro?: string
  readonly cep?: string
  readonly uf?: string
  readonly municipio?: string
  readonly municipio_ibge?: number
  readonly country_code: string
}): AddressComponents => ({
  tipoLogradouro: dto.tipo_logradouro,
  logradouro: dto.logradouro,
  numero: dto.numero,
  complemento: dto.complemento,
  bairro: dto.bairro,
  cep: dto.cep,
  uf: dto.uf,
  municipio: dto.municipio,
  municipioIbge: dto.municipio_ibge,
  countryCode: dto.country_code,
})

export const makeValidationController = (deps: ValidationControllerDeps) => ({
  get: async (
    tenantId: string | undefined,
    validationId: string,
    ifNoneMatch: string | undefined,
    reply: FastifyReply,
  ) => {
    if (tenantId === undefined) throw new Error('tenant context missing')
    const result = await getValidationDetails(deps.db, tenantId, validationId)
    if (result === null) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('validation'))
    }
    const {
      validation,
      signals,
      claim,
      evidenceSummary,
      evidenceVerification,
      fiscalVerification,
      fiscalReferenceStatus,
      progress,
      address,
    } = result
    const parsedVerification =
      evidenceVerification === null ? null : EvidenceVerificationDtoSchema.safeParse(evidenceVerification)
    // O `detail` fiscal persiste campos de auditoria (hash da referência, IP
    // resolvido, digest da resposta) que não podem vazar para o cliente: o Zod
    // strips unknown keys, expondo apenas o subconjunto do contrato.
    const parsedFiscal =
      fiscalVerification === null ? null : FiscalVerificationDtoSchema.safeParse(fiscalVerification)
    // Whitelist do status da referência fiscal: o valor vem do JSONB da análise.
    const parsedReference = FiscalReferenceStatusSchema.safeParse(fiscalReferenceStatus)
    // Estado durável da reavaliação fiscal (coluna da validation).
    const parsedReassessment = FiscalReassessmentStateSchema.safeParse(validation.fiscalReassessment)

    const body: ValidationDto = {
      validation_id: validation.validationId,
      status: validation.status,
      verdict: validation.verdict,
      confidence: validation.confidence,
      score: validation.score,
      policy_version: validation.policyVersion,
      // BAIXO-7: GET devolve o MESMO endereço do POST (estado persistido).
      address:
        address === null
          ? null
          : {
              building_key: address.buildingKey,
              country: address.country,
              uf: address.uf,
              geo_precision: address.geoPrecision,
            },
      signals: signals.map((signal): ValidationDto['signals'][number] => ({
        checker: signal.checkerId,
        checker_version: signal.checkerVersion,
        stance: signal.stance,
        strength: signal.strength,
        confidence: signal.confidence,
        source: signal.source,
        observed_at: signal.observedAt.toISOString(),
        ttl_seconds: signal.ttlSeconds,
        detail: signal.detail,
        evidence_id: signal.evidenceId,
      })),
      claim:
        claim === null
          ? null
          : {
              id: claim.claimId,
              type: claim.type,
              subject: { type: claim.subjectType, id: claim.subjectId },
              target: { type: 'address', id: claim.addressId },
            },
      evidence_summary: evidenceSummary,
      evidence_verification: parsedVerification?.success === true ? parsedVerification.data : null,
      fiscal_verification: parsedFiscal?.success === true ? parsedFiscal.data : null,
      fiscal_reference: parsedReference?.success === true ? parsedReference.data : null,
      fiscal_reassessment: parsedReassessment?.success === true ? parsedReassessment.data : null,
      progress,
      explanation: summaryOf(validation.explanation),
      explanation_detail: explanationDetailFromStored(validation.explanation),
      created_at: validation.createdAt.toISOString(),
      expires_at: validation.expiresAt.toISOString(),
    }

    const etag = `W/"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`
    reply.header('etag', etag)
    if (ifNoneMatch === etag) {
      reply.code(304)
      return reply.send(null)
    }
    return reply.send(body)
  },

  create: async (
    tenant:
      | {
          readonly tenantId: string
          readonly apiKeyId: string
          readonly scopes: readonly string[]
        }
      | undefined,
    userId: string | null | undefined,
    idempotencyKey: string | undefined,
    body: CreateValidationRequest,
    reply: FastifyReply,
  ) => {
    if (tenant === undefined) throw new Error('tenant context missing')
    if ((body.mode === 'deep' || body.mode === 'auto') && deps.vlmEnabled !== true) {
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(
          problem(422, 'DEEP_PATH_DISABLED', 'Deep path is disabled (VLM_ENABLED=false); use mode: "fast"'),
        )
    }
    if (!isValidDocument(body.document.type, body.document.value)) {
      return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problems.invalidDocument())
    }
    if (body.document.type === 'CPF' && body.address === null && body.consent_ref === null) {
      return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problems.addressRequiredForCpf())
    }

    const fastRequest: FastPathRequest = {
      documentType: body.document.type,
      documentValue: body.document.value,
      addressInput:
        body.document.type === 'CPF' && body.address !== null ? addressComponentsFromDto(body.address) : null,
      legalBasis: body.legal_basis,
      mode: body.mode,
      idempotencyKey: idempotencyKey ?? null,
      consentRef: body.consent_ref,
      userId: userId ?? null,
    }
    const result = await runFastPath(
      deps.fastPath,
      { tenantId: tenant.tenantId, apiKeyId: tenant.apiKeyId, issuerScopes: tenant.scopes },
      fastRequest,
    )
    if (result.requestMismatch === true) {
      return reply
        .code(422)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency key used with different request body'))
    }

    reply.header('Location', `/v1/validations/${result.validationId}`)
    if (body.mode === 'deep') reply.code(202)
    if (body.mode === 'deep' || (body.mode === 'auto' && result.status === 'partial')) {
      void startDeepWorkflow(deps.deepTrigger, {
        tenantId: tenant.tenantId,
        validationId: result.validationId,
        maxTier: body.options.max_tier,
      })
        .then(async (workflowId) => {
          if (workflowId !== null) {
            await setWorkflowId(deps.db, tenant.tenantId, result.validationId, workflowId)
          }
        })
        .catch((error: unknown) => {
          deps.deepTrigger.logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              validation_id: result.validationId,
            },
            'failed to persist deep workflow id',
          )
        })
    }
    return reply.send(dtoFromResult(result))
  },

  contest: async (
    tenant: { readonly tenantId: string; readonly apiKeyId: string } | undefined,
    validationId: string,
    reason: string,
    encryptionKey: string,
    reply: FastifyReply,
  ) => {
    if (tenant === undefined) throw new Error('tenant context missing')
    const contested = await contestValidation(
      deps.db,
      tenant.tenantId,
      tenant.apiKeyId,
      validationId,
      reason,
      encryptionKey,
    )
    if (!contested) {
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('validation'))
    }
    return reply.send({ contested: true, validation_id: validationId })
  },

  /**
   * Emite a credencial verificável da validation. Toda a regra de negócio
   * (elegibilidade, bindings, subject, evidence set, assinatura) continua em
   * `issueCredential`/`@comprova/credential`: aqui só se escopa pelo tenant e se
   * traduz a falha de emissão no `problem+json` estável da API.
   */
  credential: async (
    tenant: { readonly tenantId: string } | undefined,
    validationId: string,
    reply: FastifyReply,
  ) => {
    if (tenant === undefined) throw new Error('tenant context missing')
    try {
      const credential = await issueCredential(deps.db, tenant.tenantId, validationId, deps.credentialIssuer)
      return reply.send(credential)
    } catch (error) {
      if (!(error instanceof CredentialIssuanceError)) throw error
      const problem =
        error.failure === 'VALIDATION_NOT_FOUND'
          ? problems.notFound('validation')
          : problems.credentialNotIssuable(error.failure)
      return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem)
    }
  },
})
