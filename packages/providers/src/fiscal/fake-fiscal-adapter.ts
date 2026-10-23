import {
  FiscalAdapterUnavailableError,
  emptyFiscalAudit,
  type DocumentOutcome,
  type EvidenceVerificationAudit,
  type FiscalAdapter,
  type FiscalSourceId,
  type MatchOutcome,
  type VerificationEnvironment,
  type VerificationMethod,
} from '@comprova/core'

export interface FakeFiscalAdapterOptions {
  readonly source?: FiscalSourceId
  readonly version?: string
  readonly method?: VerificationMethod
  readonly environment?: VerificationEnvironment
  readonly document?: DocumentOutcome
  readonly address?: MatchOutcome
  readonly holder?: MatchOutcome
  readonly issuer?: string | null
  readonly documentId?: string | null
  readonly issuedAt?: Date | null
  readonly limitations?: readonly string[]
  readonly errorCodes?: readonly string[]
  readonly audit?: EvidenceVerificationAudit
  /** Quando informado, o verify lança indisponibilidade (timeout/erro da fonte). */
  readonly unavailableReason?: string
  /** Quando informado, o verify lança erro inesperado. */
  readonly failure?: string
}

/**
 * F2.1 — adapter determinístico para exercitar o pipeline
 * (`input -> adapter -> result -> evidence observation -> claim_evidence`).
 *
 * Não faz I/O, não lê o QR e não consulta nenhuma fonte real. A resposta é
 * configurada no teste; o objetivo é validar a infraestrutura, não a NF3e.
 */
export const makeFakeFiscalAdapter = (options: FakeFiscalAdapterOptions = {}): FiscalAdapter => {
  const source = options.source ?? 'nf3e'
  const version = options.version ?? '1.0.0'

  return {
    source,
    version,
    supports: (input) => input.source === source,
    verify: async (input, context) => {
      if (options.failure !== undefined) throw new Error(options.failure)
      if (options.unavailableReason !== undefined) {
        throw new FiscalAdapterUnavailableError(options.unavailableReason)
      }

      return {
        source,
        adapterVersion: version,
        method: options.method ?? 'official_qr_consultation',
        environment: options.environment ?? 'local',
        document: options.document ?? 'authentic',
        address: options.address ?? 'not_extracted',
        holder: options.holder ?? 'not_extracted',
        issuer: options.issuer === undefined ? input.issuer : options.issuer,
        documentId: options.documentId === undefined ? input.documentId : options.documentId,
        issuedAt: options.issuedAt ?? null,
        observedAt: context.now(),
        limitations: [...(options.limitations ?? [])],
        errorCodes: [...(options.errorCodes ?? [])],
        artifact: input.artifact,
        audit: options.audit ?? emptyFiscalAudit(),
      }
    },
  }
}
