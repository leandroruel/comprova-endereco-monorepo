import { createHash } from 'node:crypto'
import { PROBLEM_CONTENT_TYPE, problem, problems, type ValidationDto } from '@comprova/contracts'
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
import { contestValidation, getValidationDetails, setWorkflowId } from './validations.service.js'

export interface ValidationControllerDeps {
  readonly db: Db
  readonly fastPath: FastPathDeps
  readonly deepTrigger: DeepTriggerDeps
  readonly vlmEnabled: boolean
}

const summaryOf = (explanation: { summary?: string } | null): string | null => {
  const summary = explanation?.summary
  return typeof summary === 'string' ? summary : null
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
    const { validation, signals } = result

    const body: ValidationDto = {
      validation_id: validation.validationId,
      status: validation.status,
      verdict: validation.verdict,
      confidence: validation.confidence,
      score: validation.score,
      policy_version: validation.policyVersion,
      address: null,
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
      explanation: summaryOf(validation.explanation),
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
    tenant: { readonly tenantId: string; readonly apiKeyId: string } | undefined,
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
      { tenantId: tenant.tenantId, apiKeyId: tenant.apiKeyId },
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
})
