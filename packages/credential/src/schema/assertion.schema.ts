import { z } from 'zod'

/**
 * Representação de emissão da assertion de domínio (FASE 1/2).
 *
 * Este NÃO é um modelo de domínio novo nem uma fonte de verdade: é um snapshot
 * derivado do grafo persistido `validation → claim → claim_evidence → signal`.
 * A fonte de verdade continua sendo o banco; aqui só se congela o conteúdo
 * derivado (o material efetivamente assinado é o documento W3C mapeado a partir
 * dele em `service/credential.service.ts`, não este objeto).
 *
 * Todas as propriedades do payload são obrigatórias (campos ausentes são
 * explicitamente `null`), para que a forma do objeto canonicalizado seja fixa e
 * determinística.
 *
 * Papel na arquitetura (ADR-0020): esta é a representação INTERNA da Comprova.
 * Ela NÃO é o documento W3C — a conversão para `VerifiableCredential` (VC Data
 * Model 2.0) é um mapping explícito em `service/credential.service.ts`. O domínio
 * (`validation → claim → claim_evidence → evidence`) continua sendo a única
 * fonte de verdade, e não é remodelado para acomodar a VC.
 */

const HEX_256 = /^[0-9a-f]{64}$/

export const HexSha256Schema = z.string().regex(HEX_256)

export const CredentialObservationSchema = z.object({
  id: z.uuid(),
  checker: z.string(),
  checker_version: z.string(),
  stance: z.enum(['supports', 'contradicts', 'unknown']),
  strength: z.number(),
  confidence: z.number(),
  source: z.string(),
  observed_at: z.iso.datetime(),
  /** Binding durável do material (`claim_evidence.evidence_sha256`); nunca `evidence_id`. */
  evidence_sha256: HexSha256Schema.nullable(),
  detail: z.unknown(),
})

/** `claim.target_type` do domínio (enum `claim_target_type` da migration 0022). */
export const ClaimTargetTypeSchema = z.enum(['address'])

export const CredentialExplanationSchema = z.object({
  code: z.string(),
  summary: z.string(),
  supporting_evidence: z.array(z.uuid()),
  contradicting_evidence: z.array(z.uuid()),
})

export const AssertionPayloadSchema = z.object({
  format: z.literal('comprova-assertion-v1'),
  issuer: z.object({
    id: z.string().min(1),
    authority: z.object({ scopes: z.array(z.string()) }).nullable(),
  }),
  subject: z.object({
    id: z.string().min(1),
    doc_type: z.enum(['CPF', 'CNPJ']),
  }),
  claim: z.object({
    id: z.uuid(),
    type: z.enum(['business_registered_address', 'address_exists']),
    subject_type: z.enum(['organization', 'person']),
    target: z.object({
      type: ClaimTargetTypeSchema,
      id: z.uuid().nullable(),
      building_key: z.string().nullable(),
    }),
  }),
  evidence: z.object({
    set_hash: HexSha256Schema,
    summary: z.object({
      supporting: z.number().int(),
      contradicting: z.number().int(),
      unknown: z.number().int(),
    }),
    observations: z.array(CredentialObservationSchema).min(1),
  }),
  policy: z.object({
    version: z.string().min(1),
    hash: HexSha256Schema,
  }),
  algorithm: z.object({
    scorer_version: z.string().min(1),
  }),
  result: z.object({
    status: z.literal('completed'),
    verdict: z.string().min(1),
    score: z.number(),
    confidence: z.number(),
    explanation: CredentialExplanationSchema.nullable(),
  }),
  legal_basis: z.string().min(1),
  timestamps: z.object({
    /** Início da validation (`validation.created_at`); NÃO é `validFrom`. */
    created_at: z.iso.datetime(),
    /**
     * Conclusão da análise (`validation.completed_at`), persistida pelo fluxo
     * rápido e pelo deep path. É o `validFrom` do documento (ADR-0024 §5) e, por
     * isso, pré-requisito da emissão: `buildAssertion` recusa emitir sem ele.
     */
    completed_at: z.iso.datetime(),
    /** Horizonte de RETENÇÃO da validation (não é o `validUntil` da VC). */
    expires_at: z.iso.datetime(),
    /**
     * Horizonte de VALIDADE da credencial:
     * `min(completed_at + policy.credential_ttl_seconds,
     *      min(observed_at + ttl_seconds))`.
     */
    valid_until: z.iso.datetime(),
  }),
})

export type CredentialObservation = z.infer<typeof CredentialObservationSchema>
export type AssertionPayload = z.infer<typeof AssertionPayloadSchema>

/** Observação carregada de `claim_evidence`, no formato "plain" de `AssertionSource`. */
export interface AssertionObservation {
  readonly id: string
  readonly checker: string
  readonly checkerVersion: string
  readonly stance: CredentialObservation['stance']
  readonly strength: number
  readonly confidence: number
  readonly source: string
  readonly observedAt: Date
  /** TTL do sinal/evidência (`claim_evidence.ttl_seconds`). */
  readonly ttlSeconds: number
  readonly evidenceSha256: Uint8Array | null
  readonly detail: unknown
}

/**
 * Dados já carregados do grafo persistido, no formato "plain" esperado por
 * `buildCredential`. O carregamento (acesso ao PostgreSQL) fica na fronteira da
 * aplicação; esta camada é pura e não conhece banco.
 */
export interface AssertionSource {
  readonly tenantId: string
  readonly validation: {
    readonly id: string
    readonly verdict: string | null
    readonly score: number | null
    readonly confidence: number | null
    readonly policyVersion: string
    readonly policyHash: string | null
    readonly scorerVersion: string | null
    readonly evidenceSetHash: string | null
    readonly legalBasis: string
    /**
     * Snapshot COMPLETO dos scopes da API key no momento da emissão
     * (`validation.issuer_scopes`), usado para auditoria. O mapping para a
     * credencial filtra capacidades administrativas (`assertionAuthorityScopes`).
     */
    readonly issuerScopes: readonly string[] | null
    readonly explanation: AssertionPayload['result']['explanation']
    readonly createdAt: Date
    /** Conclusão da análise; pré-requisito da emissão (`completed_at` do domínio). */
    readonly completedAt: Date | null
    /** Horizonte de retenção (`validation.expires_at`), preservado como metadado. */
    readonly expiresAt: Date
    /**
     * Horizonte de validade já calculado pela fronteira de emissão. Quando
     * omitido, `buildAssertion` usa `expiresAt` (compatibilidade dos testes
     * unitários); a API sempre calcula por policy + TTL das evidências.
     */
    readonly validUntil?: Date
  }
  readonly subject: {
    readonly docType: 'CPF' | 'CNPJ'
    readonly docHmac: Uint8Array
  }
  readonly claim: {
    readonly id: string
    readonly type: AssertionPayload['claim']['type']
    readonly subjectType: AssertionPayload['claim']['subject_type']
    /** `claim.target_type` (coluna NOT NULL do domínio). */
    readonly targetType: AssertionPayload['claim']['target']['type']
    readonly addressId: string | null
  }
  /** `building_key` do endereço-alvo já formatado (`b64:<base64url>`), ou null. */
  readonly addressBuildingKey: string | null
  readonly observations: readonly AssertionObservation[]
}
