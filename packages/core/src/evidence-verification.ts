import { normalizeCep, normalizeLogradouro, normalizeNumero, normalizeText, normalizeUf } from './address.js'
import type { DocumentAnalysisResult, ExtractedAddress, ExtractedHolder } from './document-analysis.js'
import type { EvidenceStance } from './claim.js'

/**
 * F1.3 — contrato do verificador e comparação do documento enviado.
 *
 * A análise F1.2 apenas extrai campos. Esta camada transforma a extração em
 * uma observação de verificação com três dimensões independentes:
 *
 *   document: authentic | not_found | invalid | inconclusive | unavailable | unsupported
 *   address:  matches | differs | not_extracted
 *   holder:   matches | differs | not_extracted
 *
 * O documento enviado NÃO é autenticado nesta etapa: não há consulta a
 * autorizador fiscal nem validação criptográfica. Por isso `document` fica
 * `inconclusive` quando a extração termina e a política F1.3 mantém
 * `stance = unknown`. A comparação de endereço/titular é persistida para
 * auditoria e para a F3, mas não vira `supports`/`contradicts` por si só.
 *
 * Regras duras:
 *   - `unavailable`, `inconclusive` e `unsupported` nunca viram `contradicts`;
 *   - ausência de extração é `not_extracted`, nunca `differs`;
 *   - comparação é por igualdade de campos normalizados, não por substring.
 */

export const EVIDENCE_SOURCE_KINDS = [
  'uploaded_document',
  'fiscal_nf3e',
  'fiscal_nfag',
  'public_registry',
] as const

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number]

export const VERIFICATION_METHODS = [
  'content_extraction',
  'official_qr_consultation',
  'official_xml_signature',
  'manual_review',
] as const

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

export const VERIFICATION_ENVIRONMENTS = ['production', 'homologation', 'local'] as const

export type VerificationEnvironment = (typeof VERIFICATION_ENVIRONMENTS)[number]

export const DOCUMENT_OUTCOMES = [
  'authentic',
  'not_found',
  'invalid',
  'inconclusive',
  'unavailable',
  'unsupported',
] as const

export type DocumentOutcome = (typeof DOCUMENT_OUTCOMES)[number]

export const MATCH_OUTCOMES = ['matches', 'differs', 'not_extracted'] as const

export type MatchOutcome = (typeof MATCH_OUTCOMES)[number]

export const EVIDENCE_VERIFICATION_STATUSES = [
  'completed',
  'invalid',
  'inconclusive',
  'unsupported',
  'unavailable',
] as const

export type EvidenceVerificationStatus = (typeof EVIDENCE_VERIFICATION_STATUSES)[number]

/** Fonte lógica da verificação do documento enviado (não é o intake F1.1). */
export const UPLOADED_DOCUMENT_SOURCE = 'uploaded_document'
export const UPLOADED_DOCUMENT_CHECKER = 'document_upload_verification'
/** Fonte da observação de intake criada pela F1.1 (recibo, não verificação). */
export const CUSTOMER_DOCUMENT_INTAKE_SOURCE = 'customer_submitted_document'
/** Versão da política de comparação; bump quando a semântica mudar. */
export const UPLOADED_DOCUMENT_VERIFICATION_VERSION = '1.0.0'

export interface EvidenceSourceRef {
  readonly kind: EvidenceSourceKind
  readonly id: string
  readonly authority: string | null
  readonly environment: VerificationEnvironment
}

export interface EvidenceVerificationAudit {
  readonly requestedUrl: string | null
  readonly resolvedIp: string | null
  readonly responseStatus: number | null
  readonly responseSha256: string | null
}

export interface EvidenceVerificationResult {
  readonly status: EvidenceVerificationStatus
  readonly source: EvidenceSourceRef
  readonly method: VerificationMethod
  readonly document: DocumentOutcome
  readonly address: MatchOutcome
  readonly holder: MatchOutcome
  readonly documentRef: string | null
  readonly extractedAt: Date
  readonly queriedAt: Date | null
  readonly issuedAt: Date | null
  readonly limitations: readonly string[]
  readonly errorCodes: readonly string[]
  readonly artifact: {
    readonly sha256: string
    readonly storageRef: string | null
  } | null
  readonly audit: EvidenceVerificationAudit
}

export type AddressField = 'cep' | 'uf' | 'logradouro' | 'numero' | 'bairro' | 'cidade' | 'complemento'

export interface AddressComparison {
  readonly outcome: MatchOutcome
  readonly comparedFields: readonly AddressField[]
  readonly reasonCodes: readonly string[]
}

export type HolderReferenceKind = 'legal_name' | 'trade_name' | 'none'

export interface HolderComparison {
  readonly outcome: MatchOutcome
  readonly reference: HolderReferenceKind
  readonly reasonCodes: readonly string[]
}

/**
 * Resultado estendido com o rastro determinístico da comparação. O contrato
 * público (GET) expõe apenas outcomes e códigos de razão, nunca os valores
 * extraídos.
 */
export interface UploadedDocumentVerification extends EvidenceVerificationResult {
  readonly addressComparison: AddressComparison
  readonly holderComparison: HolderComparison
}

export interface AddressComparisonTarget {
  readonly cep: string | null
  readonly uf: string | null
  readonly logradouroNorm: string | null
  readonly numero: string | null
  readonly bairroNorm: string | null
  readonly municipioNorm: string | null
  readonly complementoNorm: string | null
}

export interface HolderReference {
  readonly legalName: string | null
  readonly tradeName: string | null
}

export interface VerifyUploadedDocumentInput {
  readonly analysisId: string
  readonly artifactId: string
  readonly artifactSha256: string
  readonly contentType: string
  readonly result: DocumentAnalysisResult
  readonly addressTarget: AddressComparisonTarget | null
  readonly holderReference: HolderReference | null
}

const sourceIdOf = (contentType: string): string => {
  if (contentType === 'application/pdf') return 'upload:pdf'
  if (contentType.startsWith('image/')) return 'upload:image'
  return 'upload:document'
}

const nonEmpty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const normalized = normalizeText(value)
  return normalized.length > 0 ? normalized : null
}

const comparableCep = (value: string | null | undefined): string | null => {
  const normalized = normalizeCep(value)
  return normalized.length === 8 ? normalized : null
}

const comparableUf = (value: string | null | undefined): string | null => {
  const normalized = normalizeUf(value)
  return normalized.length === 2 ? normalized : null
}

const comparableNumero = (value: string | null | undefined): string | null => {
  const normalized = normalizeNumero(value)
  return normalized.length > 0 ? normalized : null
}

const comparableLogradouro = (value: string | null | undefined): string | null => {
  const normalized = normalizeLogradouro(null, value)
  return normalized.length > 0 ? normalized : null
}

interface AddressFieldComparison {
  readonly name: AddressField
  readonly kind: 'strong' | 'soft'
  readonly documentValue: string | null
  readonly targetValue: string | null
}

/**
 * Compara somente campos presentes dos dois lados. CEP/UF/logradouro/número
 * são fortes; bairro/cidade/complemento são de apoio e nunca, sozinhos,
 * produzem `differs` (nomes de bairro e município variam entre fontes).
 */
export const compareAddress = (
  extracted: ExtractedAddress,
  target: AddressComparisonTarget | null,
): AddressComparison => {
  if (target === null) {
    return { outcome: 'not_extracted', comparedFields: [], reasonCodes: ['TARGET_ADDRESS_MISSING'] }
  }

  const fields: readonly AddressFieldComparison[] = [
    {
      name: 'cep',
      kind: 'strong',
      documentValue: comparableCep(extracted.cep),
      targetValue: comparableCep(target.cep),
    },
    {
      name: 'uf',
      kind: 'strong',
      documentValue: comparableUf(extracted.uf),
      targetValue: comparableUf(target.uf),
    },
    {
      name: 'logradouro',
      kind: 'strong',
      documentValue: comparableLogradouro(extracted.logradouro),
      targetValue: comparableLogradouro(target.logradouroNorm),
    },
    {
      name: 'numero',
      kind: 'strong',
      documentValue: comparableNumero(extracted.numero),
      targetValue: comparableNumero(target.numero),
    },
    {
      name: 'bairro',
      kind: 'soft',
      documentValue: nonEmpty(extracted.bairro),
      targetValue: nonEmpty(target.bairroNorm),
    },
    {
      name: 'cidade',
      kind: 'soft',
      documentValue: nonEmpty(extracted.cidade),
      targetValue: nonEmpty(target.municipioNorm),
    },
    {
      name: 'complemento',
      kind: 'soft',
      documentValue: nonEmpty(extracted.complemento),
      targetValue: nonEmpty(target.complementoNorm),
    },
  ]

  const compared = fields.filter(
    (field): field is AddressFieldComparison & { documentValue: string; targetValue: string } =>
      field.documentValue !== null && field.targetValue !== null,
  )
  if (compared.length === 0) {
    return { outcome: 'not_extracted', comparedFields: [], reasonCodes: ['NO_COMPARABLE_FIELD'] }
  }

  const comparedFields = compared.map((field) => field.name)
  const strong = compared.filter((field) => field.kind === 'strong')
  if (strong.length === 0) {
    return {
      outcome: 'not_extracted',
      comparedFields,
      reasonCodes: ['NO_COMPARABLE_STRONG_FIELD'],
    }
  }

  const strongMatches = strong.filter((field) => field.documentValue === field.targetValue)
  const strongConflicts = strong.filter((field) => field.documentValue !== field.targetValue)
  const softConflicts = compared.filter(
    (field) => field.kind === 'soft' && field.documentValue !== field.targetValue,
  )

  if (strongConflicts.length > 0) {
    return {
      outcome: 'differs',
      comparedFields,
      reasonCodes: [
        'STRONG_FIELD_CONFLICT',
        ...strongConflicts.map((field) => `${field.name.toUpperCase()}_MISMATCH`),
      ],
    }
  }

  // UF sozinha não identifica um endereço; exige CEP/logradouro/número ou ao
  // menos dois campos fortes coincidentes.
  const identifiesAddress = strongMatches.some(
    (field) => field.name === 'cep' || field.name === 'logradouro' || field.name === 'numero',
  )
  if (!identifiesAddress && strongMatches.length < 2) {
    return {
      outcome: 'not_extracted',
      comparedFields,
      reasonCodes: ['INSUFFICIENT_STRONG_FIELD'],
    }
  }

  return {
    outcome: 'matches',
    comparedFields,
    reasonCodes: [
      'STRONG_FIELD_MATCH',
      ...strongMatches.map((field) => `${field.name.toUpperCase()}_MATCH`),
      ...(softConflicts.length > 0
        ? ['SOFT_FIELD_MISMATCH', ...softConflicts.map((field) => `${field.name.toUpperCase()}_MISMATCH`)]
        : []),
    ],
  }
}

const LEGAL_SUFFIXES = [
  'LTDA',
  'ME',
  'EPP',
  'EIRELI',
  'S/A',
  'S/A.',
  'S.A.',
  'SA',
  'SOCIEDADE ANONIMA',
  'MICROEMPRESA',
  'EMPRESARIO INDIVIDUAL',
] as const

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeHolderName = (value: string | null | undefined): string | null => {
  let normalized = nonEmpty(value)
  if (normalized === null) return null

  let changed = true
  while (changed) {
    changed = false
    for (const suffix of LEGAL_SUFFIXES) {
      const re = new RegExp(`(?:^|\\s)${escapeRegExp(suffix)}\\.?$`)
      if (re.test(normalized)) {
        normalized = normalized.replace(re, '').trim()
        changed = true
      }
    }
  }

  const withoutPunctuation = normalized
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return withoutPunctuation.length > 0 ? withoutPunctuation : null
}

/**
 * Comparação conservadora do titular: igualdade exata após normalização e
 * remoção de sufixos societários. Não usa substring, similaridade difusa nem
 * iniciais. Sem nome extraído ou sem referência, o resultado é
 * `not_extracted` — nunca `differs`.
 */
export const compareHolder = (
  extracted: ExtractedHolder,
  reference: HolderReference | null,
): HolderComparison => {
  const extractedName = normalizeHolderName(extracted.name)
  if (extractedName === null) {
    return { outcome: 'not_extracted', reference: 'none', reasonCodes: ['HOLDER_NOT_EXTRACTED'] }
  }
  if (reference === null) {
    return { outcome: 'not_extracted', reference: 'none', reasonCodes: ['HOLDER_REFERENCE_MISSING'] }
  }

  const legalName = normalizeHolderName(reference.legalName)
  const tradeName = normalizeHolderName(reference.tradeName)

  if (legalName !== null) {
    if (extractedName === legalName) {
      return { outcome: 'matches', reference: 'legal_name', reasonCodes: ['NAME_MATCH'] }
    }
    if (tradeName !== null && extractedName === tradeName) {
      return { outcome: 'matches', reference: 'trade_name', reasonCodes: ['NAME_MATCH'] }
    }
    return { outcome: 'differs', reference: 'legal_name', reasonCodes: ['NAME_MISMATCH'] }
  }

  if (tradeName !== null) {
    if (extractedName === tradeName) {
      return { outcome: 'matches', reference: 'trade_name', reasonCodes: ['NAME_MATCH'] }
    }
    // Nome fantasia não é identidade jurídica: um nome diferente pode ser a
    // razão social, que não temos. Sem razão social, não há como contradizer.
    return {
      outcome: 'not_extracted',
      reference: 'trade_name',
      reasonCodes: ['HOLDER_REFERENCE_WEAK'],
    }
  }

  return { outcome: 'not_extracted', reference: 'none', reasonCodes: ['HOLDER_REFERENCE_MISSING'] }
}

const documentOutcomeOf = (result: DocumentAnalysisResult): DocumentOutcome => {
  if (result.status === 'failed') return 'unavailable'
  switch (result.document.status) {
    case 'analyzed':
      // Extração concluída não é autenticação. O upload não tem prova
      // criptográfica/oficial de autenticidade.
      return 'inconclusive'
    case 'invalid':
      return 'invalid'
    case 'inconclusive':
      return 'inconclusive'
    case 'unsupported':
      return 'unsupported'
    case 'unavailable':
      return 'unavailable'
  }
}

const statusOf = (result: DocumentAnalysisResult, document: DocumentOutcome): EvidenceVerificationStatus => {
  if (document === 'invalid') return 'invalid'
  if (document === 'unsupported') return 'unsupported'
  if (document === 'unavailable') return 'unavailable'
  if (result.status === 'completed') return 'completed'
  if (result.status === 'inconclusive') return 'inconclusive'
  if (result.status === 'unsupported') return 'unsupported'
  return 'unavailable'
}

const analysisComplete = (result: DocumentAnalysisResult): boolean =>
  result.status === 'completed' && result.document.status === 'analyzed'

const extraLimitations = (document: DocumentOutcome, result: DocumentAnalysisResult): readonly string[] => {
  if (document === 'inconclusive' && result.document.status === 'analyzed') {
    return ['AUTHENTICITY_NOT_VERIFIED']
  }
  switch (document) {
    case 'inconclusive':
      return ['DOCUMENT_INCONCLUSIVE']
    case 'invalid':
      return ['DOCUMENT_INVALID']
    case 'unsupported':
      return ['DOCUMENT_UNSUPPORTED']
    case 'unavailable':
      return ['DOCUMENT_UNAVAILABLE']
    case 'authentic':
    case 'not_found':
      return []
  }
}

const emptyAddressComparison = (reason: string): AddressComparison => ({
  outcome: 'not_extracted',
  comparedFields: [],
  reasonCodes: [reason],
})

const emptyHolderComparison = (reason: string): HolderComparison => ({
  outcome: 'not_extracted',
  reference: 'none',
  reasonCodes: [reason],
})

const issuedAtOf = (result: DocumentAnalysisResult): Date | null => {
  const value = result.document.issuedAt
  if (value === null) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Transformação determinística `DocumentAnalysisResult -> verificação`.
 * Nenhum valor extraído (nome/endereço bruto) sai daqui; a persistência guarda
 * apenas outcomes, códigos de razão e metadados técnicos.
 */
export const verifyUploadedDocument = (input: VerifyUploadedDocumentInput): UploadedDocumentVerification => {
  const { result } = input
  const document = documentOutcomeOf(result)
  const status = statusOf(result, document)
  const complete = analysisComplete(result)

  const addressComparison =
    !complete || result.address.status !== 'extracted' || result.address.value === null
      ? emptyAddressComparison(complete ? 'ADDRESS_NOT_EXTRACTED' : 'DOCUMENT_NOT_ANALYZED')
      : compareAddress(result.address.value, input.addressTarget)

  const holderComparison =
    !complete || result.holder.status !== 'extracted' || result.holder.value === null
      ? emptyHolderComparison(complete ? 'HOLDER_NOT_EXTRACTED' : 'DOCUMENT_NOT_ANALYZED')
      : compareHolder(result.holder.value, input.holderReference)

  const extractedAt = new Date(result.analyzedAt)
  const limitations = [...new Set([...result.limitations, ...extraLimitations(document, result)])]

  return {
    status,
    source: {
      kind: 'uploaded_document',
      id: sourceIdOf(input.contentType),
      authority: null,
      environment: 'production',
    },
    method: 'content_extraction',
    document,
    address: addressComparison.outcome,
    holder: holderComparison.outcome,
    documentRef: `analysis:${input.analysisId}`,
    extractedAt: Number.isNaN(extractedAt.getTime()) ? new Date(0) : extractedAt,
    queriedAt: null,
    issuedAt: issuedAtOf(result),
    limitations,
    errorCodes: [...result.errorCodes],
    artifact: { sha256: input.artifactSha256, storageRef: null },
    audit: {
      requestedUrl: null,
      resolvedIp: null,
      responseStatus: null,
      responseSha256: null,
    },
    addressComparison,
    holderComparison,
  }
}

/**
 * Mapeamento de política das três dimensões para `claim_evidence.stance`.
 *
 * A decisão é de policy, não do adapter. `unavailable`, `inconclusive` e
 * `unsupported` nunca viram `contradicts`. `invalid`/`not_found` também ficam
 * `unknown` nesta política conservadora: a F3 decide quando a invalidade ou a
 * ausência é definitiva. Compartilhada pela verificação do upload (F1.3) e pela
 * fonte fiscal (F2.1).
 */
export const stanceForDimensions = (dimensions: {
  readonly document: DocumentOutcome
  readonly address: MatchOutcome
  readonly holder: MatchOutcome
}): EvidenceStance => {
  if (dimensions.document !== 'authentic') return 'unknown'
  if (dimensions.address === 'matches' && dimensions.holder !== 'differs') return 'supports'
  if (dimensions.address === 'differs' && dimensions.holder === 'matches') return 'contradicts'
  return 'unknown'
}

/**
 * Mapeamento de política do resultado para `claim_evidence.stance`.
 *
 * F1.3 não produz `authentic` (o upload não é autenticado), então o retorno é
 * sempre `unknown`. A função existe separada para que a F2 possa mapear fontes
 * oficiais sem alterar o contrato de comparação.
 */
export const stanceForVerification = (verification: EvidenceVerificationResult): EvidenceStance =>
  stanceForDimensions(verification)

/**
 * Chave estável da materialização: uma linha por claim + versão do checker.
 * A versão inclui a política de comparação, o analisador e o contrato de
 * análise, para que uma nova leitura não sobrescreva a anterior.
 */
export const uploadedDocumentCheckerVersion = (analyzerVersion: string, contractVersion: string): string =>
  `${UPLOADED_DOCUMENT_VERIFICATION_VERSION}+${analyzerVersion}+c${contractVersion}`
