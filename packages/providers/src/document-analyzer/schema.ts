import {
  DOCUMENT_ANALYSIS_DOCUMENT_STATUSES,
  DOCUMENT_ANALYSIS_EXTRACTION_STATUSES,
  DOCUMENT_ANALYSIS_KINDS,
  DOCUMENT_ANALYSIS_TERMINAL_STATUSES,
  type DocumentAnalysisResult,
} from '@comprova/core'
import { z } from 'zod'

const analysisStatusSchema = z.enum(DOCUMENT_ANALYSIS_TERMINAL_STATUSES)

const extractionStatusSchema = z.enum(DOCUMENT_ANALYSIS_EXTRACTION_STATUSES)

const extractedAddressSchema = z.object({
  logradouro: z.string().nullable(),
  numero: z.string().nullable(),
  complemento: z.string().nullable(),
  bairro: z.string().nullable(),
  cidade: z.string().nullable(),
  uf: z.string().nullable(),
  cep: z.string().nullable(),
  raw: z.string(),
})

const extractedHolderSchema = z.object({
  name: z.string().nullable(),
  raw: z.string(),
})

export const documentAnalysisResultSchema = z
  .object({
    contractVersion: z.string().min(1),
    analyzer: z.object({ id: z.string().min(1), version: z.string().min(1) }),
    status: analysisStatusSchema,
    document: z.object({
      status: z.enum(DOCUMENT_ANALYSIS_DOCUMENT_STATUSES),
      kind: z.enum(DOCUMENT_ANALYSIS_KINDS),
      issuedAt: z.iso.date().nullable(),
      issuedRaw: z.string().nullable(),
    }),
    address: z.object({
      status: extractionStatusSchema,
      value: extractedAddressSchema.nullable(),
      raw: z.string().nullable(),
    }),
    holder: z.object({
      status: extractionStatusSchema,
      value: extractedHolderSchema.nullable(),
      raw: z.string().nullable(),
    }),
    limitations: z.array(z.string()),
    errorCodes: z.array(z.string()),
    analyzedAt: z.iso.datetime(),
  })
  .superRefine((result, ctx) => {
    const add = (path: readonly (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path: [...path], message })
    }

    const dimensions = [
      { name: 'address', dimension: result.address },
      { name: 'holder', dimension: result.holder },
    ] as const

    for (const { name, dimension } of dimensions) {
      if (dimension.status === 'extracted' && dimension.value === null) {
        add([name, 'value'], `${name} extracted without a value`)
      }
      if (dimension.status !== 'extracted' && dimension.value !== null) {
        add([name, 'value'], `${name} value requires extracted status`)
      }
      if (result.status === 'completed' && dimension.status === 'unknown') {
        add([name, 'status'], `${name} cannot be unknown when analysis completed`)
      }
      if (result.status !== 'completed' && dimension.status !== 'unknown') {
        add([name, 'status'], `${name} must be unknown when analysis did not complete`)
      }
    }

    const expectedDocumentStatus =
      result.status === 'completed'
        ? ['analyzed']
        : result.status === 'inconclusive'
          ? ['invalid', 'inconclusive']
          : result.status === 'failed'
            ? ['inconclusive']
            : [result.status]

    if (!expectedDocumentStatus.includes(result.document.status)) {
      add(['document', 'status'], 'document status is incompatible with analysis status')
    }
  }) satisfies z.ZodType<DocumentAnalysisResult>
