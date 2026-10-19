import { z } from 'zod'

/**
 * Data Integrity proof com a cryptosuite `eddsa-jcs-2022`
 * (W3C VC Data Integrity 1.0 + W3C Data Integrity EdDSA Cryptosuites v1.0).
 *
 * Este arquivo concentra apenas a FORMA do proof (schemas e tipos). O algoritmo
 * de criação/verificação vive em `service/proof.service.ts`.
 *
 * O `created` é opcional na Data Integrity, mas aqui é sempre emitido; ele é
 * responsabilidade do emissor e precisa ser o momento REAL da criação da prova
 * (§2.1.1) — a camada de credencial o recebe de um relógio injetável, e nunca o
 * deriva de um timestamp histórico da assertion (ADR-0024 §4).
 */
export const DATA_INTEGRITY_PROOF_TYPE = 'DataIntegrityProof'
export const EDDSA_JCS_2022 = 'eddsa-jcs-2022'
export const ASSERTION_METHOD = 'assertionMethod'

/**
 * Campos do proof reconhecidos pela Comprova. As opções do proof estão ABERTAS
 * (`looseObject`): a Data Integrity permite propriedades adicionais no proof
 * (`expires`, `domain`, `challenge`, `nonce`, `previousProof`, …), elas fazem
 * parte do material assinado e NÃO podem ser descartadas na verificação.
 */
const PROOF_FIELDS = {
  type: z.string().min(1),
  cryptosuite: z.string().min(1),
  created: z.iso.datetime().optional(),
  verificationMethod: z.string().min(1),
  proofPurpose: z.string().min(1),
  '@context': z.unknown().optional(),
} as const

export const UnsignedDataIntegrityProofSchema = z.looseObject(PROOF_FIELDS)
export const DataIntegrityProofSchema = z.looseObject({
  ...PROOF_FIELDS,
  proofValue: z.string().min(1),
})

export type DataIntegrityProof = z.infer<typeof DataIntegrityProofSchema>
export type UnsignedDataIntegrityProof = z.infer<typeof UnsignedDataIntegrityProofSchema>

export type DataIntegrityFailure =
  | 'MALFORMED_PROOF'
  | 'UNSUPPORTED_CRYPTOSUITE'
  | 'PROOF_CONTEXT_MISMATCH'
  | 'PROOF_PURPOSE_MISMATCH'
  | 'INVALID_PROOF_VALUE'
  | 'INVALID_SIGNATURE'

export type DataIntegrityVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: DataIntegrityFailure }
