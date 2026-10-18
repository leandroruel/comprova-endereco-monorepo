import { createHash, verify as ed25519Verify, type KeyObject } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { canonicalize } from './jcs.js'
import { decodeMultibaseBase58Btc, encodeMultibaseBase58Btc } from './multibase.js'
import type { Signer } from './signer.js'

/**
 * Data Integrity proof com a cryptosuite `eddsa-jcs-2022`
 * (W3C VC Data Integrity 1.0 + W3C Data Integrity EdDSA Cryptosuites v1.0).
 *
 * Algoritmo implementado (§3.3 Create/Verify Proof), fiel ao texto normativo:
 *
 *  1. `proofOptions` = opções do proof SEM `proofValue`;
 *  2. se o documento tem `@context`, ele é COPIADO para o proof (passo 2 do
 *     Create Proof — é o que o vetor normativo B.3 demonstra);
 *  3. `proofConfig` = JCS(proofOptions) e `documento` = JCS(documento sem proof);
 *  4. `hashData` = sha256(proofConfig) || sha256(documento)   (nessa ordem);
 *  5. `proofBytes` = Ed25519(hashData) (Pure EdDSA);
 *  6. `proofValue` = multibase base58btc (`z…`) de `proofBytes`.
 *
 * O `created` é opcional na Data Integrity, mas aqui é sempre emitido; ele é
 * responsabilidade do emissor (a camada de credencial o deriva da assertion,
 * para manter `mesma assertion → mesmos bytes`).
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

export interface CreateDataIntegrityProofOptions {
  readonly verificationMethod: string
  readonly proofPurpose: string
  readonly created: string
  readonly signer: Signer
}

export class DataIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataIntegrityError'
  }
}

export type DataIntegrityFailure =
  | 'MALFORMED_PROOF'
  | 'UNSUPPORTED_CRYPTOSUITE'
  | 'PROOF_CONTEXT_MISMATCH'
  | 'PROOF_PURPOSE_MISMATCH'
  | 'INVALID_PROOF_VALUE'
  | 'INVALID_SIGNATURE'

export type DataIntegrityVerificationResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: DataIntegrityFailure }

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest()

/** Cópia rasa sem uma propriedade (documento sem `proof`; opções sem `proofValue`). */
const without = <T extends object, K extends keyof T>(object: T, key: K): Omit<T, K> => {
  const copy = { ...object } as Record<string, unknown>
  delete copy[key as string]
  return copy as Omit<T, K>
}

/** §3.3.4 Hashing: `sha256(proofConfig)` seguido de `sha256(documento)`. */
const hashData = (
  proofOptions: UnsignedDataIntegrityProof,
  unsecuredDocument: Record<string, unknown>,
): Buffer => Buffer.concat([sha256(canonicalize(proofOptions)), sha256(canonicalize(unsecuredDocument))])

/**
 * §3.3.5 Proof Configuration: valida `type`/`cryptosuite` e devolve uma CÓPIA
 * das opções — inclusive propriedades adicionais assinadas (`expires`, `domain`,
 * …), que não podem ser removidas. `created`, quando presente, precisa ser
 * `dateTimeStamp`.
 */
const proofConfiguration = (options: UnsignedDataIntegrityProof): UnsignedDataIntegrityProof => {
  const parsed = UnsignedDataIntegrityProofSchema.safeParse(options)
  if (!parsed.success) {
    throw new DataIntegrityError(`invalid proof options: ${parsed.error.message}`)
  }
  if (parsed.data.type !== DATA_INTEGRITY_PROOF_TYPE) {
    throw new DataIntegrityError(`proof type must be ${DATA_INTEGRITY_PROOF_TYPE}`)
  }
  if (parsed.data.cryptosuite !== EDDSA_JCS_2022) {
    throw new DataIntegrityError(`cryptosuite must be ${EDDSA_JCS_2022}`)
  }
  return parsed.data
}

/**
 * §3.3.1 Create Proof. Recebe o documento NÃO securizado (sem `proof`) e devolve
 * o proof assinado. Não muta o documento.
 */
export const createDataIntegrityProof = async (
  unsecuredDocument: Record<string, unknown>,
  options: CreateDataIntegrityProofOptions,
): Promise<DataIntegrityProof> => {
  if ('proof' in unsecuredDocument) {
    throw new DataIntegrityError('the document is already secured (it has a proof)')
  }

  const proofOptions: UnsignedDataIntegrityProof = {
    type: DATA_INTEGRITY_PROOF_TYPE,
    cryptosuite: EDDSA_JCS_2022,
    created: options.created,
    verificationMethod: options.verificationMethod,
    proofPurpose: options.proofPurpose,
  }

  // Passo 2 do Create Proof: o `@context` do documento é copiado para o proof.
  const context = unsecuredDocument['@context']
  if (context !== undefined) proofOptions['@context'] = context

  const config = proofConfiguration(proofOptions)
  const proofBytes = await options.signer.sign(hashData(config, unsecuredDocument))

  return { ...config, proofValue: encodeMultibaseBase58Btc(proofBytes) }
}

export interface VerifyDataIntegrityProofOptions {
  /** Chave pública do emissor, fornecida diretamente (MVP; ver ADR-0019). */
  readonly publicKey: KeyObject
  /**
   * §4.4 `expectedProofPurpose`: garante que a prova foi criada para o motivo
   * esperado (`assertionMethod` para uma credencial). Quando omitido, nenhuma
   * expectativa é aplicada.
   */
  readonly expectedProofPurpose?: string
}

const contextStartsWith = (document: unknown, proof: unknown): boolean =>
  Array.isArray(document) &&
  Array.isArray(proof) &&
  proof.length <= document.length &&
  proof.every((value, index) => isDeepStrictEqual(value, document[index]))

/**
 * §3.3.2 Verify Proof. Recebe o documento securizado CRU (o JSON recebido, não
 * uma versão normalizada) e a chave pública. Remove o `proof`, restaura o
 * `@context` a partir das opções do proof, recomputa `hashData` e verifica a
 * assinatura Ed25519.
 *
 * O `proofConfig` é derivado do proof **cru** (menos `proofValue`), não de uma
 * versão filtrada pelo schema: propriedades assinadas que a Comprova não conhece
 * precisam continuar cobertas pela assinatura (e verificáveis).
 */
export const verifyDataIntegrityProof = (
  securedDocument: Record<string, unknown>,
  options: VerifyDataIntegrityProofOptions,
): DataIntegrityVerificationResult => {
  const rawProof = securedDocument['proof']
  const parsed = DataIntegrityProofSchema.safeParse(rawProof)
  if (!parsed.success) return { valid: false, reason: 'MALFORMED_PROOF' }

  const proof = parsed.data
  if (proof.type !== DATA_INTEGRITY_PROOF_TYPE || proof.cryptosuite !== EDDSA_JCS_2022) {
    return { valid: false, reason: 'UNSUPPORTED_CRYPTOSUITE' }
  }
  if (options.expectedProofPurpose !== undefined && proof.proofPurpose !== options.expectedProofPurpose) {
    return { valid: false, reason: 'PROOF_PURPOSE_MISMATCH' }
  }

  const document = without(securedDocument, 'proof')
  const proofOptions = without(
    rawProof as Record<string, unknown>,
    'proofValue',
  ) as UnsignedDataIntegrityProof

  // §3.3.2 passos 5–6: o `@context` do documento precisa começar pelos valores
  // do `@context` do proof (mesma ordem), e é restaurado a partir dele.
  const proofContext = proofOptions['@context']
  if (proofContext !== undefined) {
    if (!contextStartsWith(document['@context'], proofContext)) {
      return { valid: false, reason: 'PROOF_CONTEXT_MISMATCH' }
    }
    document['@context'] = proofContext
  }

  let proofBytes: Uint8Array
  try {
    proofBytes = decodeMultibaseBase58Btc(proof.proofValue)
  } catch {
    return { valid: false, reason: 'INVALID_PROOF_VALUE' }
  }

  const data = hashData(proofConfiguration(proofOptions), document)
  try {
    return ed25519Verify(null, data, options.publicKey, proofBytes)
      ? { valid: true }
      : { valid: false, reason: 'INVALID_SIGNATURE' }
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE' }
  }
}
