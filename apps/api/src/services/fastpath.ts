import { and, eq } from '@comprova/db'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  addressKeys,
  canonicalizeAddress,
  decide,
  digitsOnly,
  isValidDocument,
  weightedScore,
  type AddressComponents,
  type CepReader,
  type CanonicalAddressRef,
  type CheckContext,
  type Checker,
  type Clock,
  type EstabelecimentoRecord,
  type Policy,
  type RegistryReader,
  type Signal,
  type Verdict,
} from '@comprova/core'
import { withTenant, type Db } from '@comprova/db'
import * as t from '@comprova/db'

export interface FastPathTenantContext {
  readonly tenantId: string
  readonly apiKeyId: string
}

export interface FastPathRequest {
  readonly documentType: 'CPF' | 'CNPJ'
  readonly documentValue: string
  readonly addressInput: AddressComponents | null
  readonly legalBasis: string
  readonly mode: 'fast' | 'deep' | 'auto'
  readonly idempotencyKey: string | null
  readonly consentRef?: string | null
}

export const requestHashOf = (req: FastPathRequest): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        t: req.documentType,
        d: req.documentValue,
        a: req.addressInput,
        l: req.legalBasis,
        m: req.mode,
      }),
    )
    .digest('hex')

export interface FastPathDeps {
  readonly db: Db
  readonly registry: RegistryReader
  readonly checkers: readonly Checker[]
  readonly policy: Policy
  readonly clock: Clock
  readonly docHmacKey: string
  readonly cep?: CepReader
}

export interface FastPathResult {
  readonly validationId: string
  readonly subjectId: string
  readonly addressId: string | null
  readonly status: 'completed' | 'partial' | 'queued'
  readonly verdict: Verdict
  readonly confidence: number
  readonly score: number
  readonly explanation: string
  readonly signals: readonly Signal[]
  readonly address: {
    readonly buildingKey: string
    readonly country: string
    readonly uf: string | null
    readonly municipioIbge: number | null
  } | null
  readonly policyVersion: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly idempotentReplay: boolean
  readonly requestMismatch?: boolean
}

const hmacDoc = (key: string, docType: string, digits: string): Buffer =>
  createHmac('sha256', key).update(`${docType}:${digits}`).digest()

export const docHmacKeyFromPepper = (pepper: string): string =>
  createHash('sha256').update(`doc-hmac:${pepper}`).digest('hex')

const splitCnpj = (
  digits: string,
): { readonly basico: string; readonly ordem: string; readonly dv: string } => ({
  basico: digits.slice(0, 8),
  ordem: digits.slice(8, 12),
  dv: digits.slice(12, 14),
})

export const deepContextOf = (
  registryRecord: EstabelecimentoRecord | undefined,
  docDigitsValid: boolean,
): Record<string, unknown> | null =>
  registryRecord === undefined
    ? null
    : {
        docDigitsValid,
        record: {
          ...registryRecord,
          buildingKey:
            registryRecord.buildingKey === null
              ? null
              : Buffer.from(registryRecord.buildingKey).toString('hex'),
          unitKey:
            registryRecord.unitKey === null ? null : Buffer.from(registryRecord.unitKey).toString('hex'),
        },
      }

const statusFor = (
  mode: 'fast' | 'deep' | 'auto',
  verdict: Verdict,
  confidence: number,
): 'completed' | 'partial' | 'queued' => {
  if (mode === 'deep') return 'queued'
  if (mode === 'auto') {
    return verdict === 'INSUFFICIENT_EVIDENCE' || confidence < 0.55 ? 'partial' : 'completed'
  }
  return 'completed'
}

const enrichWithCep = async (
  deps: FastPathDeps,
  input: AddressComponents | null,
): Promise<AddressComponents | null> => {
  if (input === null || deps.cep === undefined) return input
  if (input.municipioIbge !== undefined && input.municipioIbge !== null) return input
  const cep = (input.cep ?? '').replace(/\D+/g, '')
  if (cep.length !== 8) return input
  const cepRecord = await deps.cep.get(cep)
  if (cepRecord === null || cepRecord.municipioIbge === null) return input
  return { ...input, municipioIbge: cepRecord.municipioIbge }
}

const addressFromRegistry = (record: EstabelecimentoRecord): AddressComponents => ({
  tipoLogradouro: record.tipoLogradouro,
  logradouro: record.logradouro,
  numero: record.numero,
  complemento: record.complemento,
  bairro: record.bairro,
  cep: record.cep,
  uf: record.uf,
  municipioIbge: record.municipioIbge,
  countryCode: 'BR',
})

const runCheckers = async (
  deps: FastPathDeps,
  documentType: 'CPF' | 'CNPJ',
  docDigitsValid: boolean,
  registryRecord: EstabelecimentoRecord | undefined,
  address: CanonicalAddressRef | null,
): Promise<readonly Signal[]> =>
  deps.checkers.reduce<Promise<readonly Signal[]>>(async (acc, checker) => {
    const priorSignals = await acc
    if (!checker.appliesTo.includes(documentType)) return priorSignals
    const ctx: CheckContext = {
      subject: { docType: documentType, docDigitsValid, pseudonymized: true },
      ...(registryRecord !== undefined ? { registryRecord } : {}),
      address,
      priorSignals,
      clock: deps.clock,
      metrics: {
        increment: () => undefined,
        observe: () => undefined,
      },
    }
    const produced = await Promise.race([
      checker.run(ctx),
      new Promise<readonly Signal[]>((_, reject) =>
        setTimeout(() => reject(new Error(`checker ${checker.id} timeout`)), checker.timeoutMs),
      ),
    ]).catch((err: unknown) => {
      if (err instanceof Error && err.message.includes('timeout')) {
        return [
          {
            checkerId: checker.id,
            checkerVersion: checker.version,
            stance: 'unknown' as const,
            strength: 0,
            confidence: 0,
            source: `${checker.id}:timeout`,
            observedAt: deps.clock.now().toISOString(),
            ttlSeconds: 300,
            detail: { reason: 'checker_timeout', timeout_ms: checker.timeoutMs },
          },
        ]
      }
      throw err
    })
    return [...priorSignals, ...produced]
  }, Promise.resolve([]))

const loadValidationForReplay = async (
  db: Db,
  tenantId: string,
  validationId: string,
  policyVersion: string,
  idempotencyKey?: string,
): Promise<FastPathResult> => {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(t.validation).where(eq(t.validation.validationId, validationId)).limit(1),
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`idempotency points to missing validation ${validationId}`)
  }
  const signalRows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(t.signal).where(eq(t.signal.validationId, validationId)),
  )

  let cachedAddress: FastPathResult['address'] = null
  if (idempotencyKey !== undefined) {
    const idemRows = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ responseAddress: t.validationIdempotency.responseAddress })
        .from(t.validationIdempotency)
        .where(
          and(
            eq(t.validationIdempotency.tenantId, tenantId),
            eq(t.validationIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1),
    )
    const addr = idemRows[0]?.responseAddress as {
      building_key?: string
      country?: string
      uf?: string | null
      municipioIbge?: number | null
    } | null
    if (addr !== null && addr !== undefined && addr.building_key !== undefined) {
      cachedAddress = {
        buildingKey: addr.building_key,
        country: addr.country ?? 'BR',
        uf: addr.uf ?? null,
        municipioIbge: addr.municipioIbge ?? null,
      }
    }
  }

  return {
    validationId: row.validationId,
    subjectId: row.subjectId,
    addressId: row.addressId,
    status: row.status as FastPathResult['status'],
    verdict: row.verdict ?? 'INSUFFICIENT_EVIDENCE',
    confidence: row.confidence ?? 0,
    score: row.score ?? 0,
    explanation: row.explanation?.summary ?? '',
    signals: signalRows.map((s): Signal => ({
      checkerId: s.checkerId,
      checkerVersion: s.checkerVersion,
      stance: s.stance,
      strength: s.strength,
      confidence: s.confidence,
      source: s.source,
      observedAt: s.observedAt.toISOString(),
      ttlSeconds: s.ttlSeconds,
      detail: s.detail,
    })),
    address: cachedAddress,
    policyVersion,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    idempotentReplay: true,
  }
}

const findExistingIdempotency = async (
  db: Db,
  tenantId: string,
  idempotencyKey: string,
): Promise<{ readonly validationId: string; readonly requestHash: string | null } | null> => {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        validationId: t.validationIdempotency.validationId,
        requestHash: t.validationIdempotency.requestHash,
      })
      .from(t.validationIdempotency)
      .where(
        and(
          eq(t.validationIdempotency.tenantId, tenantId),
          eq(t.validationIdempotency.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1),
  )
  const row = rows[0]
  return row === undefined ? null : { validationId: row.validationId, requestHash: row.requestHash }
}

export const runFastPath = async (
  deps: FastPathDeps,
  tenant: FastPathTenantContext,
  req: FastPathRequest,
): Promise<FastPathResult> => {
  const now = deps.clock.now()
  const digits = digitsOnly(req.documentValue)
  const docHmac = hmacDoc(deps.docHmacKey, req.documentType, digits)
  const reqHash = requestHashOf(req)

  const policyVersion = deps.policy.version

  if (req.idempotencyKey !== null) {
    const existing = await findExistingIdempotency(deps.db, tenant.tenantId, req.idempotencyKey)
    if (existing !== null) {
      if (existing.requestHash !== null && existing.requestHash !== reqHash) {
        return {
          validationId: existing.validationId,
          subjectId: '',
          addressId: null,
          status: 'completed',
          verdict: 'INSUFFICIENT_EVIDENCE',
          confidence: 0,
          score: 0,
          explanation: 'Idempotency key used with different request body',
          signals: [],
          address: null,
          policyVersion,
          createdAt: now,
          expiresAt: now,
          idempotentReplay: true,
          requestMismatch: true,
        }
      }
      return loadValidationForReplay(
        deps.db,
        tenant.tenantId,
        existing.validationId,
        policyVersion,
        req.idempotencyKey ?? undefined,
      )
    }
  }

  const resolved =
    req.documentType === 'CNPJ' ? await deps.registry.getEstabelecimento(splitCnpj(digits)) : null
  const registryRecord = resolved === null ? undefined : resolved

  const rawAddressInput =
    registryRecord !== undefined ? addressFromRegistry(registryRecord) : req.addressInput
  const addressInput = await enrichWithCep(deps, rawAddressInput)

  const canonical = canonicalizeAddress(addressInput ?? {})
  const keys = addressKeys(canonical)
  const addressRef: CanonicalAddressRef | null =
    addressInput === null
      ? null
      : {
          buildingKey: keys.buildingKey,
          unitKey: keys.unitKey,
          country: canonical.countryCode,
          uf: canonical.uf ?? undefined,
          cep: canonical.cep ?? undefined,
          municipioIbge: canonical.municipioIbge ?? undefined,
          logradouroNorm: canonical.logradouroNorm,
          numero: canonical.numeroNorm,
          bairroNorm: canonical.bairroNorm ?? undefined,
          exterior: canonical.isExterior,
        }

  const docDigitsValid = isValidDocument(req.documentType, req.documentValue)
  const signals = await runCheckers(deps, req.documentType, docDigitsValid, registryRecord, addressRef)

  const score = weightedScore(signals, deps.policy, now)
  const decision = decide({ signals, score, policy: deps.policy, now })
  const normalizedScore = Math.tanh(score)
  const status = statusFor(req.mode, decision.verdict, decision.confidence)
  const validationId = randomUUID()
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000)

  const persisted = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const subjectRows = await tx
      .insert(t.subject)
      .values({
        subjectId: randomUUID(),
        tenantId: tenant.tenantId,
        docType: req.documentType,
        docHmac,
      })
      .onConflictDoNothing()
      .returning({ subjectId: t.subject.subjectId })
    const subjectId =
      subjectRows[0]?.subjectId ??
      (
        await tx
          .select({ subjectId: t.subject.subjectId })
          .from(t.subject)
          .where(
            and(
              eq(t.subject.tenantId, tenant.tenantId),
              eq(t.subject.docType, req.documentType),
              eq(t.subject.docHmac, docHmac),
            ),
          )
          .limit(1)
      )[0]?.subjectId
    if (subjectId === undefined) throw new Error('subject upsert failed')

    let addressId: string | null = null
    if (addressInput !== null) {
      await tx
        .insert(t.canonicalAddress)
        .values({
          addressId: randomUUID(),
          buildingKey: keys.buildingKey,
          countryCode: canonical.countryCode,
          uf: canonical.uf,
          municipioIbge: canonical.municipioIbge,
          cep: canonical.cep,
          logradouroNorm: canonical.logradouroNorm,
          numero: canonical.numeroNorm,
          bairroNorm: canonical.bairroNorm,
        })
        .onConflictDoNothing()
      const addressRows = await tx
        .select({ addressId: t.canonicalAddress.addressId })
        .from(t.canonicalAddress)
        .where(eq(t.canonicalAddress.buildingKey, keys.buildingKey))
        .limit(1)
      addressId = addressRows[0]?.addressId ?? null
    }

    if (req.idempotencyKey !== null) {
      const idemRows = await tx
        .insert(t.validationIdempotency)
        .values({
          tenantId: tenant.tenantId,
          idempotencyKey: req.idempotencyKey,
          validationId,
          requestHash: reqHash,
          responseAddress:
            addressInput === null
              ? null
              : {
                  building_key: `b64:${keys.buildingKey.toString('base64url')}`,
                  country: canonical.countryCode,
                  uf: canonical.uf,
                  municipioIbge: canonical.municipioIbge,
                },
        })
        .onConflictDoNothing()
        .returning({ validationId: t.validationIdempotency.validationId })
      if (idemRows.length === 0) {
        const winner = await findExistingIdempotency(tx as never, tenant.tenantId, req.idempotencyKey)
        if (winner !== null) {
          return { replay: winner.validationId, subjectId, addressId }
        }
      }
    }

    await tx.insert(t.validation).values({
      validationId,
      tenantId: tenant.tenantId,
      subjectId,
      addressId,
      mode: req.mode,
      status,
      verdict: decision.verdict,
      score: normalizedScore,
      confidence: decision.confidence,
      policyVersion,
      legalBasis: req.legalBasis,
      idempotencyKey: req.idempotencyKey,
      consentRef: req.consentRef ?? null,
      explanation: { summary: decision.explanation },
      deepContext: deepContextOf(registryRecord, docDigitsValid),
      createdAt: now,
      expiresAt,
    })

    if (signals.length > 0) {
      await tx.insert(t.signal).values(
        signals.map((s) => ({
          signalId: randomUUID(),
          validationId,
          checkerId: s.checkerId,
          checkerVersion: s.checkerVersion,
          stance: s.stance,
          strength: s.strength,
          confidence: s.confidence,
          source: s.source,
          observedAt: new Date(s.observedAt),
          ttlSeconds: s.ttlSeconds,
          detail: s.detail,
          evidenceId: s.evidenceId ?? null,
        })),
      )
    }

    await tx.insert(t.outbox).values({
      aggregate: 'validation',
      aggregateId: validationId,
      eventType: status === 'completed' ? 'validation.completed' : 'validation.updated',
      payload: {
        validation_id: validationId,
        tenant_id: tenant.tenantId,
        status,
        verdict: decision.verdict,
      },
    })

    await tx.insert(t.usageEvent).values({
      tenantId: tenant.tenantId,
      kind: 'fast',
      units: 1,
      validationId,
    })

    await tx.insert(t.auditLog).values({
      tenantId: tenant.tenantId,
      actor: `api-key:${tenant.apiKeyId}`,
      action: 'validation.create',
      targetType: 'validation',
      targetId: validationId,
      details: { mode: req.mode, verdict: decision.verdict, status },
    })

    return { replay: null, subjectId, addressId }
  })

  if (persisted.replay !== null) {
    return loadValidationForReplay(
      deps.db,
      tenant.tenantId,
      persisted.replay,
      policyVersion,
      req.idempotencyKey ?? undefined,
    )
  }

  return {
    validationId,
    subjectId: persisted.subjectId,
    addressId: persisted.addressId,
    status,
    verdict: decision.verdict,
    confidence: decision.confidence,
    score: normalizedScore,
    explanation: decision.explanation,
    signals,
    address:
      addressInput === null
        ? null
        : {
            buildingKey: `b64:${keys.buildingKey.toString('base64url')}`,
            country: canonical.countryCode,
            uf: canonical.uf,
            municipioIbge: canonical.municipioIbge,
          },
    policyVersion,
    createdAt: now,
    expiresAt,
    idempotentReplay: false,
  }
}
