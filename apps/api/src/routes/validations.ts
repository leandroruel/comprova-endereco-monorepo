import { createHash } from 'node:crypto'
import {
  CreateValidationRequestSchema,
  PROBLEM_CONTENT_TYPE,
  ValidationDtoSchema,
  ProblemSchema,
  problem,
  problems,
  type ValidationDto,
} from '@comprova/contracts'
import { isValidDocument, type AddressComponents } from '@comprova/core'
import { eq, withTenant, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  runFastPath,
  type FastPathDeps,
  type FastPathResult,
  type FastPathRequest,
} from '../services/fastpath.js'
import { startDeepWorkflow, type DeepTriggerDeps } from '../services/deep-trigger.js'
import { encryptSecret } from '../webhooks.js'

const GetValidationParams = z.object({ id: z.uuid() })

const CreateValidationHeaders = z.object({
  'idempotency-key': z.string().min(8).max(128).optional(),
})

export interface ValidationRoutesDeps {
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
  signals: result.signals.map((s) => ({
    checker: s.checkerId,
    checker_version: s.checkerVersion,
    stance: s.stance,
    strength: s.strength,
    confidence: s.confidence,
    source: s.source,
    observed_at: s.observedAt,
    ttl_seconds: s.ttlSeconds,
    detail: s.detail,
    evidence_id: s.evidenceId ?? null,
  })),
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

export const registerValidationRoutes = (instance: FastifyInstance, deps: ValidationRoutesDeps): void => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/validations/:id',
    {
      schema: {
        params: GetValidationParams,
        response: {
          200: ValidationDtoSchema,
          304: z.null(),
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) {
        throw new Error('tenant context missing')
      }
      const id = request.params.id

      const rows = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({
            validationId: t.validation.validationId,
            status: t.validation.status,
            verdict: t.validation.verdict,
            score: t.validation.score,
            confidence: t.validation.confidence,
            policyVersion: t.validation.policyVersion,
            explanation: t.validation.explanation,
            createdAt: t.validation.createdAt,
            expiresAt: t.validation.expiresAt,
          })
          .from(t.validation)
          .where(eq(t.validation.validationId, id))
          .limit(1),
      )
      const row = rows[0]
      if (row === undefined) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('validation'))
      }

      const signals = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
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
          .where(eq(t.signal.validationId, id))
          .orderBy(t.signal.createdAt),
      )

      const body: ValidationDto = {
        validation_id: row.validationId,
        status: row.status,
        verdict: row.verdict,
        confidence: row.confidence,
        score: row.score,
        policy_version: row.policyVersion,
        address: null,
        signals: signals.map((s): ValidationDto['signals'][number] => ({
          checker: s.checkerId,
          checker_version: s.checkerVersion,
          stance: s.stance,
          strength: s.strength,
          confidence: s.confidence,
          source: s.source,
          observed_at: s.observedAt.toISOString(),
          ttl_seconds: s.ttlSeconds,
          detail: s.detail,
          evidence_id: s.evidenceId,
        })),
        explanation: summaryOf(row.explanation),
        created_at: row.createdAt.toISOString(),
        expires_at: row.expiresAt.toISOString(),
      }

      const etag = `W/"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`
      reply.header('etag', etag)
      if (request.headers['if-none-match'] === etag) {
        reply.code(304)
        return reply.send(null)
      }
      return reply.send(body)
    },
  )

  app.post(
    '/validations',
    {
      schema: {
        headers: CreateValidationHeaders,
        body: CreateValidationRequestSchema,
        response: {
          200: ValidationDtoSchema,
          202: ValidationDtoSchema,
          422: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) {
        throw new Error('tenant context missing')
      }
      const body = request.body
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
          body.document.type === 'CPF' && body.address !== null
            ? addressComponentsFromDto(body.address)
            : null,
        legalBasis: body.legal_basis,
        mode: body.mode,
        idempotencyKey: request.headers['idempotency-key'] ?? null,
        consentRef: body.consent_ref,
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
      if (body.mode === 'deep') {
        reply.code(202)
      }
      if (body.mode === 'deep' || (body.mode === 'auto' && result.status === 'partial')) {
        void startDeepWorkflow(deps.deepTrigger, {
          tenantId: tenant.tenantId,
          validationId: result.validationId,
          maxTier: body.options.max_tier,
        })
          .then(async (workflowId) => {
            if (workflowId === null) return
            await withTenant(deps.db, tenant.tenantId, (tx) =>
              tx
                .update(t.validation)
                .set({ workflowId })
                .where(eq(t.validation.validationId, result.validationId)),
            )
          })
          .catch(() => undefined)
      }
      return reply.send(dtoFromResult(result))
    },
  )

  app.post(
    '/validations/:id/contest',
    {
      schema: {
        params: GetValidationParams,
        body: z.object({ reason: z.string().min(10).max(2000) }),
        response: {
          200: z.object({ contested: z.boolean(), validation_id: z.uuid() }),
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant
      if (tenant === undefined) throw new Error('tenant context missing')
      const exists = await withTenant(deps.db, tenant.tenantId, (tx) =>
        tx
          .select({ validationId: t.validation.validationId })
          .from(t.validation)
          .where(eq(t.validation.validationId, request.params.id))
          .limit(1),
      )
      if (exists.length === 0) {
        return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound('validation'))
      }
      await withTenant(deps.db, tenant.tenantId, async (tx) => {
        await tx.insert(t.auditLog).values({
          tenantId: tenant.tenantId,
          actor: `api-key:${tenant.apiKeyId}`,
          action: 'validation.contested',
          targetType: 'validation',
          targetId: request.params.id,
          details: {
            reason_enc: encryptSecret(deps.fastPath.docHmacKey, request.body.reason).toString('base64'),
            reason_length: request.body.reason.length,
          },
        })
        await tx.insert(t.outbox).values({
          aggregate: 'validation',
          aggregateId: request.params.id,
          eventType: 'validation.contested',
          payload: {
            tenant_id: tenant.tenantId,
            validation_id: request.params.id,
          },
        })
      })
      return reply.send({ contested: true, validation_id: request.params.id })
    },
  )
}
