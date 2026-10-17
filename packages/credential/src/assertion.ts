import { z } from 'zod'

/**
 * Representação de emissão da assertion de domínio (FASE 1/2).
 *
 * Este NÃO é um modelo de domínio novo nem uma fonte de verdade: é um snapshot
 * derivado do grafo persistido `validation → claim → claim_evidence → signal`.
 * A fonte de verdade continua sendo o banco; aqui só se congela o conteúdo que
 * será canonicalizado e assinado.
 *
 * Todas as propriedades do payload são obrigatórias (campos ausentes são
 * explicitamente `null`), para que a forma do objeto canonicalizado seja fixa e
 * determinística.
 */

const HEX_256 = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

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
    authorization: z.object({ scopes: z.array(z.string()) }).nullable(),
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
      type: z.literal('address'),
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
    created_at: z.iso.datetime(),
    completed_at: z.iso.datetime().nullable(),
    expires_at: z.iso.datetime(),
  }),
})

export const CredentialProofSchema = z.object({
  type: z.literal('Ed25519Signature'),
  /** Referência à chave do issuer; a chave pública é fornecida ao verifier. */
  key_id: z.string().min(1),
  /** Assinatura Ed25519 (base64url) sobre `canonicalAssertionBytes(payload)`. */
  signature: z.string().regex(BASE64URL),
})

export const CredentialSchema = z.object({
  payload: AssertionPayloadSchema,
  proof: CredentialProofSchema,
})

export type CredentialObservation = z.infer<typeof CredentialObservationSchema>
export type AssertionPayload = z.infer<typeof AssertionPayloadSchema>
export type CredentialProof = z.infer<typeof CredentialProofSchema>
export type Credential = z.infer<typeof CredentialSchema>

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
    readonly issuerScopes: readonly string[] | null
    readonly explanation: AssertionPayload['result']['explanation']
    readonly createdAt: Date
    readonly completedAt: Date | null
    readonly expiresAt: Date
  }
  readonly subject: {
    readonly docType: 'CPF' | 'CNPJ'
    readonly docHmac: Uint8Array
  }
  readonly claim: {
    readonly id: string
    readonly type: AssertionPayload['claim']['type']
    readonly subjectType: AssertionPayload['claim']['subject_type']
    readonly addressId: string | null
  }
  /** `building_key` do endereço-alvo já formatado (`b64:<base64url>`), ou null. */
  readonly addressBuildingKey: string | null
  readonly observations: readonly AssertionObservation[]
}
