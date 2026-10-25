import {
  DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  DOCUMENT_ANALYZER_ID,
  DOCUMENT_ANALYZER_VERSION,
  type DocumentAnalysisDimension,
  type DocumentAnalysisDocument,
  type DocumentAnalysisResult,
  type ExtractedAddress,
  type ExtractedHolder,
} from '@comprova/core'

export const baseResult = (
  now: Date,
): Pick<DocumentAnalysisResult, 'contractVersion' | 'analyzer' | 'analyzedAt' | 'fiscalReference'> => ({
  contractVersion: DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  analyzer: { id: DOCUMENT_ANALYZER_ID, version: DOCUMENT_ANALYZER_VERSION },
  analyzedAt: now.toISOString(),
  fiscalReference: null,
})

const unknownDimension = <T>(): DocumentAnalysisDimension<T> => ({
  status: 'unknown',
  value: null,
  raw: null,
})

const failureResult = (
  now: Date,
  input: {
    readonly status: DocumentAnalysisResult['status']
    readonly document: DocumentAnalysisDocument
    readonly limitations: readonly string[]
    readonly errorCodes: readonly string[]
  },
): DocumentAnalysisResult => ({
  ...baseResult(now),
  status: input.status,
  document: input.document,
  address: unknownDimension<ExtractedAddress>(),
  holder: unknownDimension<ExtractedHolder>(),
  limitations: input.limitations,
  errorCodes: input.errorCodes,
})

export const unavailableResult = (now: Date, reason: string): DocumentAnalysisResult =>
  failureResult(now, {
    status: 'unavailable',
    document: { status: 'unavailable', kind: 'unknown', issuedAt: null, issuedRaw: null },
    limitations: [reason],
    errorCodes: [reason],
  })

export const invalidResult = (now: Date, reason: string): DocumentAnalysisResult =>
  failureResult(now, {
    status: 'inconclusive',
    document: { status: 'invalid', kind: 'unknown', issuedAt: null, issuedRaw: null },
    limitations: [reason],
    errorCodes: [reason],
  })

export const inconclusiveResult = (now: Date, reason: string): DocumentAnalysisResult =>
  failureResult(now, {
    status: 'inconclusive',
    document: { status: 'inconclusive', kind: 'unknown', issuedAt: null, issuedRaw: null },
    limitations: [reason],
    errorCodes: [reason],
  })

export const unsupportedResult = (now: Date, reason: string): DocumentAnalysisResult =>
  failureResult(now, {
    status: 'unsupported',
    document: { status: 'unsupported', kind: 'unknown', issuedAt: null, issuedRaw: null },
    limitations: [reason],
    errorCodes: [reason],
  })

export const failedResult = (now: Date, reason: string): DocumentAnalysisResult =>
  failureResult(now, {
    status: 'failed',
    document: { status: 'inconclusive', kind: 'unknown', issuedAt: null, issuedRaw: null },
    limitations: [reason],
    errorCodes: [reason],
  })
