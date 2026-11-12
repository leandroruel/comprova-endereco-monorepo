import {
  and,
  eq,
  sql,
  auditLog,
  canonicalAddress,
  claim,
  claimEvidence,
  outbox,
  signal,
  subject,
  validation,
  validationBillingKey,
  validationIdempotency,
  withTenant,
  type Db,
} from '@comprova/db'
import { makeUsageService } from '../modules/usage/usage.service.js'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  addressKeys,
  canonicalizeAddress,
  digitsOnly,
  isValidDocument,
  isValidClaimCombination,
  buildAssessmentExplanation,
  evaluateClaim,
  SCORER_VERSION,
  evidenceSetHashOfObservations,
  type AssessmentExplanation,
  type Claim,
  type ClaimType,
  type Evidence,
  type SubjectType,
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
  hasExternalUnavailability,
} from '@comprova/core'

export interface FastPathTenantContext {
  readonly tenantId: string
  /**
   * V-1: credencial que originou a asserção. `null` quando não há api_key
   * (ex.: batch), caso em que `validation.api_key_id` fica NULL — nunca se
   * atribui uma credencial arbitrária.
   */
  readonly apiKeyId: string | null
  /** Snapshot dos scopes efetivos no momento da emissão (V-1/§3). */
  readonly issuerScopes?: readonly string[] | null
}

export interface FastPathRequest {
  readonly documentType: 'CPF' | 'CNPJ'
  readonly documentValue: string
  readonly addressInput: AddressComponents | null
  readonly legalBasis: string
  readonly idempotencyKey: string | null
  readonly consentRef?: string | null
  readonly userId?: string | null
}

export const requestHashOf = (req: FastPathRequest): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        t: req.documentType,
        d: req.documentValue,
        a: req.addressInput,
        l: req.legalBasis,
      }),
    )
    .digest('hex')

export interface FastPathDeps {
  readonly db: Db
  readonly registry: RegistryReader
  readonly checkers: readonly Checker[]
  readonly policy: Policy
  /** V-5: digest do conteúdo efetivo da policy carregada. */
  readonly policyHash: string
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
  readonly claim?: {
    readonly id: string
    readonly type: string
    readonly subject: { readonly type: string; readonly refId: string }
    readonly target: { readonly type: string; readonly refId: string | null }
  }
  readonly evidenceSummary?: {
    readonly supporting: number
    readonly contradicting: number
    readonly unknown: number
  }
  readonly explanationDetail?: AssessmentExplanation
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

/**
 * Constrói o contexto de deep path a partir do registro do cadastro.
 *
 * Devolve `null` quando não há registro (endereço vem da entrada do usuário).
 * Caso contrário, devolve a validade dos dígitos do documento e o registro com
 * `buildingKey` e `unitKey` convertidos para hex (para não vazar binário no
 * contexto persistido).
 *
 * @param registryRecord registro do cadastro, quando disponível
 * @param docDigitsValid se os dígitos do documento são válidos
 * @returns contexto de deep ou `null`
 */
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

/**
 * Determina o status técnico da validation a partir do veredito e
 * confiança da decisão.
 *
 * Sempre `completed`: a validação é avaliada de forma determinística e
 * síncrona no fluxo único do MVP.
 *
 * @param verdict veredito da decisão
 * @param confidence confiança da decisão
 * @returns 'completed'
 */
const statusFor = (): 'completed' => {
  return 'completed'
}

/**
 * Reconstrói o `AssessmentExplanation` a partir da explicação armazenada no
 * banco (JSON). Devolve `undefined` quando não há explicação ou quando o
 * campo `code` não é uma string (ex.: registros antigos sem código).
 *
 * @param explanation explicação armazenada (summary, code, listas de evidências)
 * @returns `AssessmentExplanation` ou `undefined`
 */
const explanationDetailFromStored = (
  explanation: {
    summary?: string
    code?: string
    supporting_evidence?: string[]
    contradicting_evidence?: string[]
  } | null,
): AssessmentExplanation | undefined => {
  if (explanation === null || typeof explanation.code !== 'string') return undefined
  return {
    code: explanation.code,
    message: explanation.summary ?? '',
    supportingEvidenceIds: explanation.supporting_evidence ?? [],
    contradictingEvidenceIds: explanation.contradicting_evidence ?? [],
  }
}

/**
 * Enriquece os componentes de endereço com o município do IBGE a partir do CEP.
 *
 * Só consulta o provedor de CEP quando há um CEP completo (8 dígitos) e o
 * município ainda não está preenchido. Devolve a entrada inalterada quando não
 * há provedor de CEP, o CEP é inválido ou o município não é encontrado.
 *
 * @param deps dependências (inclui o CepReader opcional)
 * @param input componentes do endereço de entrada
 * @returns componentes do endereço, com `municipioIbge` preenchido quando possível
 */
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

/**
 * Executa os checkers em sequência para um documento, encadeando os sinais
 * produzidos (`priorSignals`). Cada checker roda com seu próprio `timeoutMs`
 * via `Promise.race`: um checker em timeout vira um sinal `unknown` com
 * `source '<id>:timeout'` e `detail.reason 'checker_timeout'`, sem abortar a
 * execução dos demais. Erros não-timeout são propagados.
 *
 * @param deps dependências (checkers, clock, CEP, etc.)
 * @param documentType tipo do documento ('CPF' | 'CNPJ')
 * @param docDigitsValid se os dígitos do documento são válidos
 * @param registryRecord registro do cadastro, quando disponível
 * @param address referência do endereço canônico
 * @returns sinais produzidos pelos checkers (prior + novos), em ordem
 */
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

/**
 * Carrega o resumo do claim (dados e contagem de evidências por stance)
 * associado a uma validation.
 *
 * @param db instância do banco
 * @param tenantId tenant proprietário
 * @param validationId id da validation
 * @returns claim e evidenceSummary, ou undefined quando não há claim
 */
const loadClaimSummary = async (
  db: Db,
  tenantId: string,
  validationId: string,
): Promise<{
  readonly claim: FastPathResult['claim']
  readonly evidenceSummary: FastPathResult['evidenceSummary']
}> =>
  withTenant(db, tenantId, async (tx) => {
    const claimRows = await tx
      .select({
        claimId: claim.claimId,
        type: claim.type,
        subjectType: claim.subjectType,
        subjectId: claim.subjectId,
        addressId: claim.addressId,
      })
      .from(claim)
      .where(eq(claim.validationId, validationId))
      .limit(1)
    const claimRow = claimRows[0]
    if (claimRow === undefined) return { claim: undefined, evidenceSummary: undefined }
    const countRows = await tx
      .select({ stance: claimEvidence.stance, count: sql<number>`count(*)::int` })
      .from(claimEvidence)
      .where(eq(claimEvidence.claimId, claimRow.claimId))
      .groupBy(claimEvidence.stance)
    const byStance = new Map(countRows.map((row) => [row.stance, row.count]))
    return {
      claim: {
        id: claimRow.claimId,
        type: claimRow.type,
        subject: { type: claimRow.subjectType, refId: claimRow.subjectId },
        target: { type: 'address', refId: claimRow.addressId },
      },
      evidenceSummary: {
        supporting: byStance.get('supports') ?? 0,
        contradicting: byStance.get('contradicts') ?? 0,
        unknown: byStance.get('unknown') ?? 0,
      },
    }
  })

/**
 * Carrega uma validation já persistida para replay de idempotência.
 *
 * Retorna o `FastPathResult` reconstruído a partir dos dados armazenados
 * (validation, sinais associados, endereço de resposta em cache pela chave de
 * idempotência e resumo do claim/evidências), com `idempotentReplay: true`.
 * Lança `Error` quando a validation apontada pela chave não existe.
 *
 * @param db instância do banco
 * @param tenantId tenant proprietário
 * @param validationId id da validation a reproduzir
 * @param policyVersion versão da policy a reportar no resultado
 * @param idempotencyKey chave usada para recuperar o endereço em cache
 * @returns resultado da validation previamente persistida
 */
const loadValidationForReplay = async (
  db: Db,
  tenantId: string,
  validationId: string,
  policyVersion: string,
  idempotencyKey?: string,
): Promise<FastPathResult> => {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(validation).where(eq(validation.validationId, validationId)).limit(1),
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`idempotency points to missing validation ${validationId}`)
  }
  const signalRows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(signal).where(eq(signal.validationId, validationId)),
  )

  let cachedAddress: FastPathResult['address'] = null
  if (idempotencyKey !== undefined) {
    const idemRows = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ responseAddress: validationIdempotency.responseAddress })
        .from(validationIdempotency)
        .where(
          and(
            eq(validationIdempotency.tenantId, tenantId),
            eq(validationIdempotency.idempotencyKey, idempotencyKey),
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
    explanationDetail: explanationDetailFromStored(row.explanation),
    ...(await loadClaimSummary(db, tenantId, validationId)),
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
        validationId: validationIdempotency.validationId,
        requestHash: validationIdempotency.requestHash,
      })
      .from(validationIdempotency)
      .where(
        and(
          eq(validationIdempotency.tenantId, tenantId),
          eq(validationIdempotency.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1),
  )
  const row = rows[0]
  return row === undefined ? null : { validationId: row.validationId, requestHash: row.requestHash }
}

/**
 * Executa o caminho rápido (fast path) de uma validação de endereço (F3.3).
 *
 * Fluxo:
 * 1. Resolve idempotência: se a `idempotencyKey` já foi usada com o mesmo
 *    corpo da requisição, devolve o resultado previamente persistido (replay)
 *    sem reavaliar nem consumir cota novamente.
 * 2. Resolve o registro no cadastro (CNPJ), enriquece o endereço (CEP) e
 *    canoniciza o endereço de entrada.
 * 3. Executa os checkers (T0), cada um com seu próprio `timeoutMs`; um
 *    checker em timeout produz um sinal `unknown` com `source '<id>:timeout'`
 *    e não falha a execução.
 * 4. Avalia o claim com a policy, produz veredito, score, confiança e status
 *    (`completed` / `partial` / `queued`).
 * 5. Persiste subject, endereço canônico, claim, evidências, sinais e
 *    validation dentro de uma única transação.
 * 6. Registra um evento de uso idempotente:
 *    - Conclusão técnica (`completed`): evento `usage_event`, faturável
 *      (`billable = true`) salvo quando não há indisponibilidade de fonte
 *      externa (`hasExternalUnavailability`); usa a chave canônica
 *      `validation:<validationId>` para compartilhar a identidade comercial
 *      com o deep path (no máximo uma cobrança por validação).
 *    - Não terminal (`partial`/`queued`) ou indisponibilidade externa:
 *      evento não-faturável com chave própria, sem consumir cota.
 * 7. Emite `auditLog` e retorna o resultado (ou o replay do vencedor em caso
 *    de conflito de idempotência dentro da transação).
 *
 * @param deps dependências (banco, registro, checkers, policy, clock, etc.)
 * @param tenant contexto do tenant (tenantId, apiKeyId, issuerScopes)
 * @param req requisição de validação (documento, endereço, modo, chave de idempotência)
 * @returns resultado do fast path, incluindo sinais, veredito, status e endereço
 */
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

  const claimType: ClaimType = req.documentType === 'CNPJ' ? 'business_registered_address' : 'address_exists'
  const claimSubjectType: SubjectType = req.documentType === 'CNPJ' ? 'organization' : 'person'
  if (!isValidClaimCombination(claimType, claimSubjectType)) {
    throw new Error(`invalid claim combination: ${claimType} for ${claimSubjectType}`)
  }
  const claimId = randomUUID()
  const claimData: Claim = {
    id: claimId,
    type: claimType,
    subject: {
      type: claimSubjectType,
      refId: 'pending',
    },
    target: {
      type: 'address',
      refId: null,
    },
  }

  const signalIds = signals.map(() => randomUUID())
  const evidenceList: Evidence[] = signals.map((signal, index) => ({
    id: randomUUID(),
    claimId,
    checker: signal.checkerId,
    checkerVersion: signal.checkerVersion,
    stance: signal.stance,
    strength: signal.strength,
    confidence: signal.confidence,
    source: signal.source,
    observedAt: signal.observedAt,
    ttlSeconds: signal.ttlSeconds,
    detail: signal.detail,
    signalId: signalIds[index] ?? null,
  }))

  const evidenceStanceOf = (stance: Evidence['stance']): 'supports' | 'contradicts' | 'unknown' =>
    stance === 'neutral' ? 'unknown' : stance

  const evidenceSummary = {
    supporting: evidenceList.filter((e) => e.stance === 'supports').length,
    contradicting: evidenceList.filter((e) => e.stance === 'contradicts').length,
    unknown: evidenceList.filter((e) => e.stance === 'unknown' || e.stance === 'neutral').length,
  }

  const { score, decision } = evaluateClaim({
    claim: claimData,
    evidence: evidenceList,
    policy: deps.policy,
    now,
  })
  const explanationDetail = buildAssessmentExplanation(decision, evidenceList)
  const normalizedScore = Math.tanh(score)
  const status = statusFor()
  const validationId = randomUUID()
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000)
  // `now` é o instante em que a requisição COMEÇOU (`created_at`); a conclusão da
  // análise (Receita + enriquecimento + checkers + evaluateClaim) só acontece
  // aqui. `completed_at` registra esse instante — é ele que a credencial usa como
  // `validFrom` (ADR-0024 §5), então não pode ser substituído por `created_at`.
  // Mesma semântica do deep path (`updateValidationOutcome`): só a validação
  // terminal completa tem instante de conclusão; `queued`/`partial` ficam NULL e
  // o deep path preenche quando concluir. Não há migração: a coluna já existe.
  const completedAt = status === 'completed' ? deps.clock.now() : null

  const persisted = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const subjectRows = await tx
      .insert(subject)
      .values({
        subjectId: randomUUID(),
        tenantId: tenant.tenantId,
        docType: req.documentType,
        docHmac,
      })
      .onConflictDoNothing()
      .returning({ subjectId: subject.subjectId })
    const subjectId =
      subjectRows[0]?.subjectId ??
      (
        await tx
          .select({ subjectId: subject.subjectId })
          .from(subject)
          .where(
            and(
              eq(subject.tenantId, tenant.tenantId),
              eq(subject.docType, req.documentType),
              eq(subject.docHmac, docHmac),
            ),
          )
          .limit(1)
      )[0]?.subjectId
    if (subjectId === undefined) throw new Error('subject upsert failed')

    let addressId: string | null = null
    if (addressInput !== null) {
      await tx
        .insert(canonicalAddress)
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
        .select({ addressId: canonicalAddress.addressId })
        .from(canonicalAddress)
        .where(eq(canonicalAddress.buildingKey, keys.buildingKey))
        .limit(1)
      addressId = addressRows[0]?.addressId ?? null
    }

    if (req.idempotencyKey !== null) {
      const idemRows = await tx
        .insert(validationIdempotency)
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
        .returning({ validationId: validationIdempotency.validationId })
      if (idemRows.length === 0) {
        const winner = await findExistingIdempotency(tx as never, tenant.tenantId, req.idempotencyKey)
        if (winner !== null) {
          return { replay: winner.validationId, subjectId, addressId }
        }
      }
    }

    // O claim é sempre criado junto da validation: nunca deve existir uma
    // validation persistida sem o seu claim (ver ADR-0016).
    await tx.insert(claim).values({
      claimId,
      tenantId: tenant.tenantId,
      validationId,
      subjectId,
      addressId,
      type: claimType,
      subjectType: claimSubjectType,
      targetType: 'address',
    })

    if (signals.length > 0) {
      await tx.insert(claimEvidence).values(
        evidenceList.map((e) => ({
          claimEvidenceId: e.id,
          tenantId: tenant.tenantId,
          claimId: e.claimId,
          signalId: e.signalId,
          // Fast path (T0) não produz artefato material; `evidence_id` fica nulo.
          evidenceId: null,
          evidenceSha256: null,
          checker: e.checker,
          checkerVersion: e.checkerVersion,
          stance: evidenceStanceOf(e.stance),
          strength: e.strength,
          confidence: e.confidence,
          source: e.source,
          observedAt: new Date(e.observedAt),
          ttlSeconds: e.ttlSeconds,
          expiresAt: new Date(Date.parse(e.observedAt) + e.ttlSeconds * 1000),
          detail: e.detail,
        })),
      )

      await tx.insert(signal).values(
        signals.map((s, index) => ({
          signalId: signalIds[index] ?? randomUUID(),
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
          // `signal.evidence_id` referencia SOMENTE artefato material (`evidence`).
          // O vínculo signal↔observação é `claim_evidence.signal_id`.
          evidenceId: null,
        })),
      )
    }

    // §9/§10: evidence-set hash determinístico, calculado sobre o estado
    // PERSISTIDO (float4/jsonb já normalizados) para ser reproduzível a partir
    // do banco. Usa `evidence_sha256` (durável), nunca `evidence_id` (efêmero).
    const observationRows = await tx
      .select({
        id: claimEvidence.claimEvidenceId,
        checker: claimEvidence.checker,
        checkerVersion: claimEvidence.checkerVersion,
        stance: claimEvidence.stance,
        strength: claimEvidence.strength,
        confidence: claimEvidence.confidence,
        source: claimEvidence.source,
        observedAt: claimEvidence.observedAt,
        evidenceSha256: claimEvidence.evidenceSha256,
        detail: claimEvidence.detail,
      })
      .from(claimEvidence)
      .where(eq(claimEvidence.claimId, claimId))
    const evidenceSetHash = evidenceSetHashOfObservations(observationRows)

    await tx.insert(validation).values({
      validationId,
      tenantId: tenant.tenantId,
      subjectId,
      addressId,
      mode: 'fast',
      status,
      verdict: decision.verdict,
      score: normalizedScore,
      confidence: decision.confidence,
      policyVersion,
      policyHash: deps.policyHash,
      scorerVersion: SCORER_VERSION,
      legalBasis: req.legalBasis,
      idempotencyKey: req.idempotencyKey,
      consentRef: req.consentRef ?? null,
      userId: req.userId ?? null,
      apiKeyId: tenant.apiKeyId,
      issuerScopes: tenant.issuerScopes != null ? [...tenant.issuerScopes] : null,
      evidenceSetHash,
      explanation: {
        summary: decision.explanation,
        code: explanationDetail.code,
        supporting_evidence: [...explanationDetail.supportingEvidenceIds],
        contradicting_evidence: [...explanationDetail.contradictingEvidenceIds],
      },
      deepContext: deepContextOf(registryRecord, docDigitsValid),
      createdAt: now,
      completedAt: completedAt,
      expiresAt,
    })

    await tx.insert(outbox).values({
      aggregate: 'validation',
      aggregateId: validationId,
      eventType: status === 'completed' ? 'validation.completed' : 'validation.updated',
      payload: {
        validation_id: validationId,
        tenant_id: tenant.tenantId,
        claim_id: claimId,
        claim_type: claim.type,
        status,
        verdict: decision.verdict,
      },
    })

    // Evento de uso (F3.3): idempotente, com rastreamento de faturabilidade
    // e proteção de cota hard. Grava dentro da mesma transação da validation.
    //
    // Identidades separadas (ADR-0044 §3):
    // - Execução técnica / tentativa (status não terminal): evento
    //   `processing_attempt`, não faturável, com chave própria — NUNCA usa a
    //   chave comercial canônica, para não bloquear o faturamento legítimo de
    //   uma conclusão posterior (deep).
    // - Unidade comercial faturável: evento `usage_event` com a chave canônica
    //   `validation:<id>` compartilhada com o deep path; o banco garante, via
    //   `usage_billing_unit (tenant_id, validation_id)`, que fast e deep não
    //   gerem duas cobranças para a mesma validação.
    // - Conclusão técnica ≠ elegibilidade comercial: um checker em timeout ou
    //   uma fonte externa indisponível tornam a validação concluída NÃO
    //   faturável (política provisória do ADR-0044 §3), sem alterar o status.
    const externalUnavailability = hasExternalUnavailability(signals)
    const usage = makeUsageService({ db: deps.db })
    if (status === 'completed') {
      const billable = !externalUnavailability
      await usage.recordUsageEventInTx(tx, {
        tenantId: tenant.tenantId,
        eventType: 'usage_event',
        kind: 'validation',
        units: 1,
        validationId,
        idempotencyKey: billable ? validationBillingKey(validationId) : null,
        billable,
        source: 'validation',
      })
    } else {
      await usage.recordUsageEventInTx(tx, {
        tenantId: tenant.tenantId,
        eventType: 'processing_attempt',
        kind: 'validation',
        units: 1,
        validationId,
        billable: false,
        source: 'validation',
      })
    }

    await tx.insert(auditLog).values({
      tenantId: tenant.tenantId,
      actor: tenant.apiKeyId === null ? 'system:batch' : `api-key:${tenant.apiKeyId}`,
      action: 'validation.create',
      targetType: 'validation',
      targetId: validationId,
      details: { verdict: decision.verdict, status },
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
    claim: {
      id: claimId,
      type: claimType,
      subject: {
        type: claimSubjectType,
        refId: persisted.subjectId,
      },
      target: {
        type: 'address',
        refId: persisted.addressId,
      },
    },
    evidenceSummary,
    explanationDetail,
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
