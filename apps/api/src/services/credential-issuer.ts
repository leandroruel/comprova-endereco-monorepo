import { DEFAULT_CREDENTIAL_TTL_SECONDS } from '@comprova/core'
import * as t from '@comprova/db'
import { and, eq, withTenant } from '@comprova/db'
import type { Db } from '@comprova/db'
import {
  buildAssertion,
  buildCredential,
  credentialIdOf,
  issuerScopeOf,
  localIssuer,
  type AssertionSource,
  type SecuredVerifiableCredential,
  type Signer,
} from '@comprova/credential'
import {
  SigningKeyProviderError,
  type SigningKeyProvider,
  type SigningKeyRequest,
} from './signing-key-provider.js'
import {
  CredentialIssuanceIdentityConflictError,
  ensureFirstCredentialIssuance,
} from './credential-status.js'
import { signingKeyTrustedCondition } from './signing-key-lifecycle.js'

/**
 * Fronteira de acesso ao PostgreSQL do builder de credencial (FASE 9). Carrega
 * o grafo da assertion já persistida (validation → claim → claim_evidence →
 * subject) para o formato "plain" de `AssertionSource`. Nenhuma tabela fora
 * desse grafo é consultada. A camada `@comprova/credential` é pura.
 *
 * Elegibilidade (FASE 9/10): só emite para `status = 'completed'` com resultado
 * completo, bindings presentes, o instante de conclusão registrado
 * (`completed_at`) e janela de validade não vazia (`completed_at < validUntil`).
 * `validUntil` é o horizonte da CREDENCIAL
 * (`min(completed_at + policy.credential_ttl_seconds, observed_at + ttl_seconds
 * de cada evidência)`), distinto de `expires_at`, que continua sendo o
 * horizonte de RETENÇÃO. NÃO emite silenciosamente para `partial`, NÃO presume
 * `created_at` como conclusão quando `completed_at` falta e NÃO estende o
 * horizonte: sem timestamp falha com `COMPLETION_TIME_MISSING`; janela
 * vazia/invertida falha com `VALIDITY_WINDOW_INVALID`.
 */

export type CredentialIssuanceFailure =
  | 'VALIDATION_NOT_FOUND'
  | 'VALIDATION_NOT_FINAL'
  | 'COMPLETION_TIME_MISSING'
  | 'VALIDITY_WINDOW_INVALID'
  | 'CLAIM_MISSING'
  | 'SUBJECT_MISSING'
  | 'EVIDENCE_MISSING'
  | 'SIGNING_KEY_UNAVAILABLE'
  | 'SIGNING_KEY_MISMATCH'
  | 'ISSUANCE_IDENTITY_CONFLICT'

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
        ttlSeconds: t.claimEvidence.ttlSeconds,
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

/** Chave de assinatura ativa do tenant, como persistida (só material público). */
export interface ActiveSigningKey {
  readonly keyId: string
  /** 32 bytes crus da chave pública Ed25519 publicada para este `key_id`. */
  readonly publicKey: Buffer
  /**
   * Referência do backend externo de assinatura (ARN do AWS KMS) ou `null` para
   * material local. O domínio só repassa ao provider; não interpreta o valor.
   */
  readonly kmsKeyReference: string | null
}

/**
 * Lê a chave de assinatura ATIVA e CONFIÁVEL do tenant (FASE 14 + ADR-0029). A
 * leitura é escopada por RLS (`withTenant`), então um tenant nunca enxerga a
 * chave de outro. O índice parcial único `issuer_signing_key_active_uq` garante
 * que exista no máximo uma ativa por tenant — a seleção é determinística, sem
 * "qual das ativas?".
 *
 * `revoked_at` é um eixo separado de `active`: uma chave pode continuar ativa
 * para rotação e ter sido revogada/vencida. Nesse caso ela não é selecionada, e
 * a emissão falha fechado. Uma chave apenas rotacionada (`active = false`) já
 * não era selecionada e continua publicada para verificar o passado.
 *
 * Devolver `null` (nenhuma chave ativa/confiável) NÃO é um erro aqui: a decisão
 * de falhar fechado é do chamador (`issueCredential`), para que o motivo fique
 * explícito.
 */
export const loadActiveSigningKey = async (db: Db, tenantId: string): Promise<ActiveSigningKey | null> =>
  withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        keyId: t.issuerSigningKey.keyId,
        publicKey: t.issuerSigningKey.publicKey,
        kmsKeyReference: t.issuerSigningKey.kmsKeyReference,
      })
      .from(t.issuerSigningKey)
      .where(
        and(
          eq(t.issuerSigningKey.tenantId, tenantId),
          eq(t.issuerSigningKey.active, true),
          signingKeyTrustedCondition(),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row === undefined
      ? null
      : { keyId: row.keyId, publicKey: row.publicKey, kmsKeyReference: row.kmsKeyReference }
  })

/**
 * Resolve o `Signer` da chave JÁ SELECIONADA pelo provider de assinatura e
 * traduz a falha tipada do provider para `CredentialIssuanceError`, preservando
 * os códigos (`SIGNING_KEY_UNAVAILABLE`/`SIGNING_KEY_MISMATCH`). A resolução
 * acontece ANTES de persistir a primeira emissão: material ausente ou incoerente
 * falha fechado, sem deixar um status ACTIVE de credencial que nunca foi
 * devolvida. A assinatura em si (KMS) pode falhar DEPOIS da persistência; o
 * `Signer` devolvido traduz essa falha para o mesmo tipo, e a credencial não é
 * devolvida — a reemissão reaproveita a primeira emissão já persistida.
 */
const signerForIssuance = async (
  provider: SigningKeyProvider,
  tenantId: string,
  signingKey: ActiveSigningKey,
): Promise<Signer> => {
  const request: SigningKeyRequest = {
    tenantId,
    keyId: signingKey.keyId,
    publicKey: signingKey.publicKey,
    kmsKeyReference: signingKey.kmsKeyReference,
  }
  try {
    return signerWithDomainErrors(await provider.signerFor(request))
  } catch (error) {
    if (error instanceof SigningKeyProviderError) {
      throw new CredentialIssuanceError(error.failure, error.message)
    }
    throw error
  }
}

/**
 * Envolve o `Signer` para traduzir falhas do provider no momento da
 * ASSINATURA. No backend local a assinatura é infalível na prática; no AWS KMS
 * ela atravessa a rede e pode falhar (ou devolver uma assinatura que não
 * corresponde à pública publicada) DEPOIS que `signerFor` já resolveu. Sem
 * esta camada, um erro do KMS escaparia como erro cru (500) em vez de
 * `CredentialIssuanceError` com `SIGNING_KEY_UNAVAILABLE`/
 * `SIGNING_KEY_MISMATCH`.
 */
export const signerWithDomainErrors = (signer: Signer): Signer => ({
  sign: async (bytes) => {
    try {
      return await signer.sign(bytes)
    } catch (error) {
      if (error instanceof SigningKeyProviderError) {
        throw new CredentialIssuanceError(error.failure, error.message)
      }
      throw error
    }
  },
})

export interface IssueCredentialDeps {
  /**
   * Origem HTTPS controlada pelo projeto (`CREDENTIAL_ISSUER_ORIGIN`). O `id` do
   * issuer é derivado dela + tenant, então o caller não escolhe o issuer: não
   * existe caminho para atribuir a assertion de um tenant ao issuer de outro.
   */
  readonly issuerOrigin: string
  /**
   * Provider de assinatura por (`tenant_id`, `key_id`). Resolve o material da
   * chave JÁ SELECIONADA (o domínio não escolhe a chave nem conhece onde o
   * material vive: configuração local, KMS ou HSM) e devolve um `Signer`. NÃO
   * existe chave global de fallback: tenant sem material configurado ou com
   * material incoerente falha fechado (`SIGNING_KEY_UNAVAILABLE`/
   * `SIGNING_KEY_MISMATCH`).
   */
  readonly signingKeyProvider: SigningKeyProvider
  /**
   * Horizonte da CREDENCIAL em segundos (`policy.credential_ttl_seconds`).
   * Omitido = 30 dias, o default das policies já publicadas. NÃO é o horizonte
   * de retenção (`validation.expires_at`).
   */
  readonly credentialTtlSeconds?: number
  /**
   * Relógio da emissão (`proof.created` = momento real da prova). Injetável para
   * testes; default: o relógio do sistema.
   */
  readonly now?: () => Date
}

/**
 * `validUntil` da credencial = menor instante entre:
 *  - `completed_at + credential_ttl_seconds` (horizonte da policy);
 *  - `observed_at + ttl_seconds` de CADA evidência usada no resultado.
 *
 * O segundo termo impede que a credencial afirme um veredito depois que uma das
 * observações que o sustentam já expirou. `expires_at` (retenção) não entra na
 * conta. Função pura e exportada para teste.
 */
export const credentialValidUntilOf = (
  source: Pick<AssertionSource, 'validation' | 'observations'>,
  credentialTtlSeconds: number = DEFAULT_CREDENTIAL_TTL_SECONDS,
): Date => {
  const completedAt = source.validation.completedAt
  if (completedAt === null) {
    throw new CredentialIssuanceError(
      'COMPLETION_TIME_MISSING',
      'validation has no completion timestamp (completed_at); refusing to compute a validity window',
    )
  }
  const policyHorizon = completedAt.getTime() + credentialTtlSeconds * 1000
  const evidenceHorizon = Math.min(
    ...source.observations.map((o) => o.observedAt.getTime() + o.ttlSeconds * 1000),
  )
  return new Date(Math.min(policyHorizon, evidenceHorizon))
}

/** Dependências de assinatura do issuer já resolvidas no boot (sem relógio). */
export type CredentialIssuerDeps = Omit<IssueCredentialDeps, 'now'>

/**
 * `validation_id → carrega o grafo → resolve a chave ativa do tenant → provider
 * de assinatura → payload → canonicalização → assinatura → credencial`.
 *
 * A chave sai do par (tenant, `key_id` ativo no banco), nunca de uma global. O
 * `SigningKeyProvider` resolve o material dessa chave (onde ele vive é detalhe
 * do provider) e valida que a pública publicada (`issuer_signing_key`)
 * CORRESPONDE a ele — senão a credencial nasceria assinada por uma chave que o
 * verificador não resolve (`SIGNING_KEY_MISMATCH`).
 */
export const issueCredential = async (
  db: Db,
  tenantId: string,
  validationId: string,
  deps: IssueCredentialDeps,
): Promise<SecuredVerifiableCredential> => {
  // O issuer é derivado do MESMO tenant que escopa a leitura (RLS): uma
  // validation de outro tenant nem é encontrada (VALIDATION_NOT_FOUND).
  const source = await loadAssertionSource(db, tenantId, validationId)

  // `validUntil` é o horizonte da credencial, não o de retenção. O cálculo
  // acontece uma única vez, antes da assinatura, e é o mesmo em uma reemissão
  // (B2): o documento assinado não pode "esticar" validade entre chamadas.
  const validUntil = credentialValidUntilOf(source, deps.credentialTtlSeconds)
  const completedAt = source.validation.completedAt
  if (completedAt !== null && validUntil.getTime() <= completedAt.getTime()) {
    throw new CredentialIssuanceError(
      'VALIDITY_WINDOW_INVALID',
      `validation ${validationId} concluded at ${completedAt.toISOString()} at or after its credential validity limit (${validUntil.toISOString()}); refusing to emit an empty or inverted window`,
    )
  }
  const credentialSource: AssertionSource = {
    ...source,
    validation: { ...source.validation, validUntil },
  }

  const signingKey = await loadActiveSigningKey(db, tenantId)
  if (signingKey === null) {
    throw new CredentialIssuanceError(
      'SIGNING_KEY_UNAVAILABLE',
      `tenant ${tenantId} has no active signing key; refusing to emit a credential it cannot sign`,
    )
  }
  // O provider resolve o material da chave JÁ SELECIONADA e confere a
  // correspondência com a pública publicada. A resolução é feita AQUI, antes de
  // persistir a primeira emissão: material ausente/incoerente não deixa um
  // status ACTIVE de credencial que nunca foi devolvida (fail closed). No KMS, a
  // assinatura em si pode falhar depois; a credencial também não é devolvida e
  // a reemissão reaproveita a primeira emissão persistida.
  const signer = await signerForIssuance(deps.signingKeyProvider, tenantId, signingKey)

  const issuer = localIssuer(deps.issuerOrigin, tenantId, signingKey.keyId)
  // Usa o id canônico que veio do banco (o parâmetro de rota pode chegar em
  // outra caixa; o Postgres compara uuid sem caixa). O id assinado e a linha de
  // status têm de ser derivados do MESMO valor, senão reemitir criaria um
  // segundo status para a mesma validation.
  const credentialId = credentialIdOf(issuer.id, credentialSource.validation.id)
  const issuerScope = issuerScopeOf(tenantId)

  // Valida a assertion ANTES de persistir a primeira emissão/status ACTIVE.
  // `buildCredential` chama `buildAssertion`, que recusa bindings ausentes
  // (validation anterior à 0028), `completed_at` nulo e evidence_set_hash
  // incoerente. Sem esta checagem, o erro só apareceria depois do commit da
  // emissão, deixando ACTIVE uma credencial que nunca foi devolvida.
  buildAssertion(credentialSource, issuer.id)

  // B2: o instante da PRIMEIRA prova é persistido na mesma transação do status.
  // Em reemissão, `issued_at` original é reutilizado como `proof.created`, de
  // modo que o documento assinado é byte a byte o mesmo (mesma issuer/key/
  // policy). Reemitir não reativa uma credencial REVOKED.
  //
  // A troca de `CREDENTIAL_ISSUER_ORIGIN` muda o `credential_id` derivado do
  // issuer, mas a linha da primeira emissão é append-only e presa à validação:
  // o conflito é traduzido para `CredentialIssuanceError` para a rota responder
  // 409 com detalhe, em vez de 500.
  let issuedAt: Date
  try {
    issuedAt = await ensureFirstCredentialIssuance(
      db,
      tenantId,
      issuerScope,
      credentialSource.validation.id,
      credentialId,
      deps.now ?? (() => new Date()),
    )
  } catch (error) {
    if (error instanceof CredentialIssuanceIdentityConflictError) {
      throw new CredentialIssuanceError('ISSUANCE_IDENTITY_CONFLICT', error.message)
    }
    throw error
  }

  // A credencial só é devolvida depois que a primeira emissão e o status ACTIVE
  // estão persistidos: se o insert falhar, a emissão falha (fail closed).
  return buildCredential(credentialSource, {
    issuer,
    signer,
    now: () => issuedAt,
    credentialId,
  })
}
