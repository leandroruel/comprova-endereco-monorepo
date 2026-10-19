import type { KeyObject } from 'node:crypto'
import { z } from 'zod'

/**
 * Identidade do issuer (VC Data Model 2.0 §4.6 + Data Integrity 1.0 §2.1.1).
 *
 * `id` é uma URL HTTPS e `keyId` é o fragmento que aponta a chave dentro dela.
 * Trocar a chave (rotação) muda o fragmento (`verificationMethod`), não a
 * identidade do issuer: a mesma origem + tenant continua produzindo o mesmo
 * `id`. A resolução do documento de chave NÃO existe nesta camada (ver
 * ADR-0024 §2): a chave pública é injetada no verifier (ADR-0019 §3).
 */
export interface IssuerIdentity {
  readonly id: string
  readonly keyId: string
}

/** Tipo W3C do método quando a chave é expressa em `publicKeyMultibase`. */
export const MULTIKEY_TYPE = 'Multikey'

export const IssuerVerificationMethodSchema = z.object({
  id: z.string().min(1),
  type: z.literal(MULTIKEY_TYPE),
  controller: z.string().min(1),
  publicKeyMultibase: z.string().min(1),
})

export const IssuerKeyDocumentSchema = z.object({
  id: z.string().min(1),
  verificationMethod: z.array(IssuerVerificationMethodSchema).min(1),
})

export type IssuerVerificationMethod = z.infer<typeof IssuerVerificationMethodSchema>
export type IssuerKeyDocument = z.infer<typeof IssuerKeyDocumentSchema>

/** Chave pública associada ao fragmento que a identifica no issuer. */
export interface IssuerVerificationKey {
  readonly keyId: string
  readonly publicKey: KeyObject
}
