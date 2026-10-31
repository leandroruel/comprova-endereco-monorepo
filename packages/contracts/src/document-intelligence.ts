import { z } from 'zod'

/**
 * Contrato do serviço Document Intelligence (apps/document-intelligence).
 *
 * O serviço Python serializa o JSON em camelCase (aliases do Pydantic). Este
 * schema é a fonte de verdade compartilhada para validar a resposta HTTP antes
 * de qualquer dado chegar ao domínio do Comprova.
 *
 * Versão atual: 1.0 (`metadata.contractVersion`).
 */
export const DOCUMENT_INTELLIGENCE_CONTRACT_VERSION = '1.0'

export const DocumentIntelligenceElementTypeSchema = z.enum([
  'heading',
  'text',
  'table',
  'image',
  'list',
  'list_item',
  'page_header',
  'page_footer',
  'code_block',
  'formula',
  'caption',
  'unknown',
])
export type DocumentIntelligenceElementType = z.infer<typeof DocumentIntelligenceElementTypeSchema>

export const DocumentIntelligenceBBoxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
})
export type DocumentIntelligenceBBox = z.infer<typeof DocumentIntelligenceBBoxSchema>

export const DocumentIntelligenceTableCellSchema = z.object({
  text: z.string(),
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  rowspan: z.number().int().positive(),
  colspan: z.number().int().positive(),
})
export type DocumentIntelligenceTableCell = z.infer<typeof DocumentIntelligenceTableCellSchema>

export const DocumentIntelligenceTableSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  cells: z.array(DocumentIntelligenceTableCellSchema),
  bbox: DocumentIntelligenceBBoxSchema.nullable(),
})
export type DocumentIntelligenceTable = z.infer<typeof DocumentIntelligenceTableSchema>

export const DocumentIntelligenceElementSchema = z.object({
  id: z.string().min(1),
  type: DocumentIntelligenceElementTypeSchema,
  text: z.string().nullable(),
  bbox: DocumentIntelligenceBBoxSchema.nullable(),
  /** O Marker 2.1.0 não expõe confiança por bloco: sempre `null` hoje. */
  confidence: z.number().nullable(),
  table: DocumentIntelligenceTableSchema.nullable(),
  imageRef: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
})
export type DocumentIntelligenceElement = z.infer<typeof DocumentIntelligenceElementSchema>

export const DocumentIntelligencePageSchema = z.object({
  pageNumber: z.number().int().positive(),
  elements: z.array(DocumentIntelligenceElementSchema),
  width: z.number().nullable(),
  height: z.number().nullable(),
})
export type DocumentIntelligencePage = z.infer<typeof DocumentIntelligencePageSchema>

export const DocumentIntelligenceDocumentSchema = z.object({
  mimeType: z.literal('application/pdf'),
  pageCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
})
export type DocumentIntelligenceDocument = z.infer<typeof DocumentIntelligenceDocumentSchema>

export const DocumentIntelligenceMetadataSchema = z.object({
  processor: z.string().min(1),
  processorVersion: z.string().min(1),
  processingTimeMs: z.number().int().nonnegative(),
  contractVersion: z.string().min(1),
})
export type DocumentIntelligenceMetadata = z.infer<typeof DocumentIntelligenceMetadataSchema>

export const DocumentIntelligenceStatusSchema = z.enum(['completed', 'failed'])
export type DocumentIntelligenceStatus = z.infer<typeof DocumentIntelligenceStatusSchema>

export const DocumentIntelligenceContentSchema = z.object({
  text: z.string().optional(),
  markdown: z.string().optional(),
})
export type DocumentIntelligenceContent = z.infer<typeof DocumentIntelligenceContentSchema>

export const DocumentIntelligenceResponseSchema = z.object({
  documentId: z.string().min(1),
  status: DocumentIntelligenceStatusSchema,
  document: DocumentIntelligenceDocumentSchema,
  content: DocumentIntelligenceContentSchema,
  pages: z.array(DocumentIntelligencePageSchema),
  metadata: DocumentIntelligenceMetadataSchema,
  warnings: z.array(z.string()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
})
export type DocumentIntelligenceResponse = z.infer<typeof DocumentIntelligenceResponseSchema>
