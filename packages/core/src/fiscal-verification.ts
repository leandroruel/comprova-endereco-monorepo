import { createHash } from 'node:crypto'
import type {
  AddressComparisonTarget,
  DocumentOutcome,
  EvidenceSourceKind,
  EvidenceSourceRef,
  EvidenceVerificationAudit,
  EvidenceVerificationStatus,
  HolderReference,
  MatchOutcome,
  VerificationEnvironment,
  VerificationMethod,
} from './evidence-verification.js'

/**
 * F2.1 — contrato de fontes fiscais.
 *
 * Uma fonte fiscal é um **adapter**, não um tipo de claim nem um novo modelo de
 * evidência. O adapter recebe uma referência de consulta (QR/chave/UF) e devolve
 * uma observação normalizada com as três dimensões do verificador:
 *
 *   document: authentic | not_found | invalid | inconclusive | unavailable | unsupported
 *   address:  matches | differs | not_extracted
 *   holder:   matches | differs | not_extracted
 *
 * `authentic` é o estado "verified" da taxonomia existente (ADR-0033): a fonte
 * oficial confirmou a existência/integridade do documento. Não criamos um
 * vocabulário paralelo.
 *
 * Regras duras:
 *   - o adapter NÃO produz `trust_score`, `final_score`, `approved`,
 *     `rejected` nem chama `weightedScore()`/aprovação;
 *   - timeout/indisponibilidade é `unavailable`, nunca `invalid`;
 *   - `unavailable`, `inconclusive` e `unsupported` nunca viram `contradicts`;
 *   - a URL do QR é uma referência NÃO confiável. O adapter nunca faz fetch
 *     dela; a URL de consulta vem de allowlist server-side e passa por
 *     `safeExternalFetch`.
 *
 * A implementação NF3e real, parsing de QR, allowlist definitiva e credenciais
 * fiscais pertencem à F2.2.
 */

export const FISCAL_SOURCE_IDS = ['nf3e', 'nfag-e'] as const

export type FiscalSourceId = (typeof FISCAL_SOURCE_IDS)[number]

/** Fonte lógica existente (`EvidenceSourceKind`) para cada identificador fiscal. */
export const FISCAL_SOURCE_KIND: Readonly<Record<FiscalSourceId, EvidenceSourceKind>> = {
  nf3e: 'fiscal_nf3e',
  'nfag-e': 'fiscal_nfag',
}

/** Versão do contrato de resultado interpretado pelo materializador. */
export const FISCAL_VERIFICATION_CONTRACT_VERSION = '1'

/**
 * Reason codes fiscais aceitos na persistência/log. O adapter é código interno,
 * mas uma allowlist finita evita que um valor arbitrário (chave, documento ou
 * segredo) seja propagado para `claim_evidence` ou log.
 */
export const FISCAL_REASON_CODES = [
  'SOURCE_NOT_SUPPORTED',
  'SOURCE_UNAVAILABLE',
  'SEFAZ_TIMEOUT',
  'ADAPTER_ERROR',
  'ADAPTER_RESULT_INVALID',
  'ADAPTER_RESULT_SOURCE_MISMATCH',
  'ADAPTER_RESULT_VERSION_MISMATCH',
  'ADAPTER_RESULT_DOCUMENT_MISMATCH',
] as const

export type FiscalReasonCode = (typeof FISCAL_REASON_CODES)[number]

export const isFiscalReasonCode = (value: string): value is FiscalReasonCode =>
  (FISCAL_REASON_CODES as readonly string[]).includes(value)

/**
 * Resultados terminais ocupam a chave estável da consulta. Resultados
 * transitórios (`unavailable`, `inconclusive`, `unsupported`) recebem um
 * discriminador na versão do checker, para que uma tentativa posterior bem-
 * sucedida não seja descartada como duplicata.
 */
export const FISCAL_TERMINAL_DOCUMENT_OUTCOMES = ['authentic', 'not_found', 'invalid'] as const

export const isFiscalTerminalDocumentOutcome = (document: DocumentOutcome): boolean =>
  (FISCAL_TERMINAL_DOCUMENT_OUTCOMES as readonly string[]).includes(document)

export interface FiscalArtifactRef {
  readonly artifactId: string
  readonly sha256: string
}

/**
 * Entrada de uma consulta fiscal.
 *
 * Não há endpoint, credencial HTTP, cookie ou função de fetch aqui: o adapter
 * concreto resolve o autorizador no servidor e usa a guarda de fetch existente.
 * `qrCodeUrl` é apenas uma referência para identificar a fonte/autorizador —
 * nunca um destino a ser buscado.
 */
export interface FiscalLookupInput {
  readonly source: FiscalSourceId
  readonly tenantId: string
  readonly claimId: string
  /** Chave de acesso/identificador do documento, quando disponível. */
  readonly documentId: string | null
  /** URL do QR Code extraída do documento. Referência não confiável. */
  readonly qrCodeUrl: string | null
  /** Autorizador/emissor identificado, quando disponível. */
  readonly issuer: string | null
  readonly uf: string | null
  readonly artifact: FiscalArtifactRef | null
}

export interface FiscalClaimContext {
  readonly address: AddressComparisonTarget | null
  readonly holder: HolderReference | null
}

/**
 * Contexto de comparação e de execução. O `now` é injetado para que o
 * resultado seja determinístico em teste; não há I/O de rede no contrato.
 */
export interface FiscalAdapterContext {
  readonly tenantId: string
  readonly claim: FiscalClaimContext
  readonly now: () => Date
}

export interface FiscalVerificationResult {
  readonly source: FiscalSourceId
  readonly adapterVersion: string
  readonly method: VerificationMethod
  readonly environment: VerificationEnvironment
  readonly document: DocumentOutcome
  readonly address: MatchOutcome
  readonly holder: MatchOutcome
  readonly issuer: string | null
  readonly documentId: string | null
  readonly issuedAt: Date | null
  readonly observedAt: Date
  readonly limitations: readonly string[]
  readonly errorCodes: readonly string[]
  readonly artifact: FiscalArtifactRef | null
  readonly audit: EvidenceVerificationAudit
}

export interface FiscalAdapter {
  readonly source: FiscalSourceId
  readonly version: string

  supports(input: FiscalLookupInput): boolean

  verify(input: FiscalLookupInput, context: FiscalAdapterContext): Promise<FiscalVerificationResult>
}

/** Indisponibilidade do adapter/fonte. Nunca deve ser mapeada para `invalid`. */
export class FiscalAdapterUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`fiscal adapter unavailable: ${reason}`)
    this.name = 'FiscalAdapterUnavailableError'
  }
}

export const emptyFiscalAudit = (): EvidenceVerificationAudit => ({
  requestedUrl: null,
  resolvedIp: null,
  responseStatus: null,
  responseSha256: null,
})

export const fiscalEvidenceSourceRef = (
  source: FiscalSourceId,
  issuer: string | null,
  environment: VerificationEnvironment,
): EvidenceSourceRef => ({
  kind: FISCAL_SOURCE_KIND[source],
  id: source,
  authority: issuer,
  environment,
})

/**
 * Status persistido no formato do verificador existente. `not_found` é uma
 * consulta concluída (a ausência é a resposta), por isso `completed`; a
 * dimensão `document` preserva `not_found`.
 */
export const fiscalVerificationStatusOf = (document: DocumentOutcome): EvidenceVerificationStatus => {
  switch (document) {
    case 'authentic':
    case 'not_found':
      return 'completed'
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

/**
 * Identidade estável da consulta para idempotência. O hash evita persistir a
 * chave de acesso/URL crua e, ao mesmo tempo, diferencia dois documentos da
 * mesma fonte no mesmo claim. A versão do adapter e do contrato entram na
 * chave final (`fiscalCheckerVersion`), preservando o histórico.
 */
export const fiscalDocumentFingerprint = (input: FiscalLookupInput): string => {
  const reference =
    input.documentId ?? input.qrCodeUrl ?? `${input.issuer ?? ''}|${input.uf ?? ''}|${input.claimId}`
  return createHash('sha256').update(`${input.source}|${reference}`).digest('hex').slice(0, 32)
}

export const fiscalCheckerId = (source: FiscalSourceId): string => `${source}_verification`

export interface FiscalCheckerVersionOptions {
  /** Fonte do adapter que executou (difere de `input.source` em `unsupported`). */
  readonly adapterSource?: FiscalSourceId
  /** Discrimina resultados transitórios na chave de idempotência. */
  readonly documentOutcome?: DocumentOutcome
}

export const fiscalCheckerVersion = (
  adapterVersion: string,
  input: FiscalLookupInput,
  options: FiscalCheckerVersionOptions = {},
): string => {
  const adapterSource = options.adapterSource === undefined ? '' : `+a${options.adapterSource}`
  const transientOutcome =
    options.documentOutcome !== undefined && !isFiscalTerminalDocumentOutcome(options.documentOutcome)
      ? `+o${options.documentOutcome}`
      : ''
  return `${adapterVersion}${adapterSource}+d${fiscalDocumentFingerprint(input)}+c${FISCAL_VERIFICATION_CONTRACT_VERSION}${transientOutcome}`
}

/**
 * Estado neutro para fonte não suportada ou falha do adapter. Não contém
 * valores extraídos nem conclusão sobre endereço/titular.
 */
export const unsupportedFiscalVerification = (
  input: FiscalLookupInput,
  adapterVersion: string,
  observedAt: Date,
  reason: string,
): FiscalVerificationResult => ({
  source: input.source,
  adapterVersion,
  method: 'official_qr_consultation',
  environment: 'production',
  document: 'unsupported',
  address: 'not_extracted',
  holder: 'not_extracted',
  issuer: input.issuer,
  documentId: input.documentId,
  issuedAt: null,
  observedAt,
  limitations: [reason],
  errorCodes: [reason],
  artifact: input.artifact,
  audit: emptyFiscalAudit(),
})

export const unavailableFiscalVerification = (
  input: FiscalLookupInput,
  adapterVersion: string,
  observedAt: Date,
  reason: string,
): FiscalVerificationResult => ({
  ...unsupportedFiscalVerification(input, adapterVersion, observedAt, reason),
  document: 'unavailable',
})
