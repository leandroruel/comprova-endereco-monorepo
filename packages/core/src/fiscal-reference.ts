import { createHash } from 'node:crypto'
import type { FiscalArtifactRef, FiscalLookupInput, FiscalSourceId } from './fiscal-verification.js'

/**
 * F2.2a — contrato da referência fiscal extraída do documento/QR.
 *
 * Esta camada fica entre a análise do documento (F1.2) e o `FiscalAdapter`
 * (F2.1). Ela responde apenas:
 *
 *   "Encontrei uma referência que parece apontar para uma fonte fiscal e sei
 *    descrevê-la de forma estruturada."
 *
 * Ela NÃO responde "o documento é autêntico". A autenticidade continua sendo
 * responsabilidade do adapter, que consulta o autorizador. A URL do QR é uma
 * referência não confiável e nunca é buscada aqui.
 *
 * A extração física do QR (decodificar a imagem) fica para F2.2b: esta etapa
 * recebe uma referência já extraída (payload do QR, URL, chave de acesso ou
 * texto) e apenas normaliza/classifica. Nenhuma dependência nova é necessária.
 */

export const FISCAL_REFERENCE_CONTRACT_VERSION = '1'

export const FISCAL_REFERENCE_STATUSES = ['found', 'not_found', 'unsupported'] as const

export type FiscalReferenceStatus = (typeof FISCAL_REFERENCE_STATUSES)[number]

export const FISCAL_REFERENCE_METHODS = ['qr_code', 'access_key', 'url', 'text', 'unknown'] as const

export type FiscalReferenceMethod = (typeof FISCAL_REFERENCE_METHODS)[number]

/**
 * Motivos finitos da extração. Como no contrato fiscal (F2.1), a lista evita
 * propagar texto arbitrário para log/persistência; a referência normalizada
 * nunca contém o payload bruto.
 */
export const FISCAL_REFERENCE_REASONS = [
  'REFERENCE_EMPTY',
  'REFERENCE_NOT_RECOGNIZED',
  'UNSAFE_REFERENCE_URL',
  'UNKNOWN_ISSUER',
  'DOCUMENT_ID_MISSING',
  'INVALID_DOCUMENT_ID',
  'NOT_NF3E_DOCUMENT',
  'SOURCE_NOT_SUPPORTED',
  'AMBIGUOUS_REFERENCE',
] as const

export type FiscalReferenceReason = (typeof FISCAL_REFERENCE_REASONS)[number]

/** Entrada do extractor: referência já extraída (QR, URL, chave ou texto). */
export interface FiscalReferenceExtractionInput {
  readonly value: string | null | undefined
  /** Origem da referência; quando omitida, o extractor infere. */
  readonly method?: FiscalReferenceMethod
}

export interface FiscalReference {
  readonly contractVersion: string
  readonly status: FiscalReferenceStatus
  /** Fonte reconhecida; `null` quando não foi possível reconhecer. */
  readonly source: FiscalSourceId | null
  /** Autorizador normalizado (ex.: `SVRS`); `null` quando não identificado. */
  readonly issuer: string | null
  /** UF normalizada de 2 letras; derivada da chave de acesso quando presente. */
  readonly uf: string | null
  /** URL normalizada (sem fragmento, query ordenada); nunca buscada. */
  readonly url: string | null
  /** Chave de acesso/identificador do documento, validada estruturalmente. */
  readonly documentId: string | null
  readonly method: FiscalReferenceMethod
  /** Condições informativas da referência; não impedem `found`. */
  readonly limitations: readonly FiscalReferenceReason[]
  /** Falhas reais de extração; vazio quando `status = found`. */
  readonly errorCodes: readonly FiscalReferenceReason[]
  /** Hash estável da referência normalizada; `null` quando não encontrada. */
  readonly fingerprint: string | null
}

/** Contexto CONFÁVEL do pipeline. O extractor não pode alterá-lo. */
export interface FiscalLookupContext {
  readonly tenantId: string
  readonly claimId: string
  readonly artifact: FiscalArtifactRef | null
}

/**
 * Transforma uma referência reconhecida em `FiscalLookupInput`. Retorna `null`
 * quando não há fonte reconhecida (`not_found`/`unsupported`) ou quando o
 * contexto confiável é inválido. Tenant/claim/artefato vêm SEMPRE do contexto,
 * nunca da referência.
 */
export const toFiscalLookupInput = (
  reference: FiscalReference,
  context: FiscalLookupContext,
): FiscalLookupInput | null => {
  if (reference.status !== 'found' || reference.source === null) return null
  if (context.tenantId.trim() === '' || context.claimId.trim() === '') return null

  return {
    source: reference.source,
    tenantId: context.tenantId,
    claimId: context.claimId,
    documentId: reference.documentId,
    qrCodeUrl: reference.url,
    issuer: reference.issuer,
    uf: reference.uf,
    artifact: context.artifact,
  }
}

/**
 * Fingerprint determinístico da referência normalizada. Diferente de
 * `fiscalDocumentFingerprint`, não depende de tenant/claim: é uma identidade
 * para logs/testes, não a chave de idempotência da consulta.
 */
export const fiscalReferenceFingerprint = (reference: FiscalReference): string | null => {
  if (reference.status !== 'found') return null
  const payload = [
    reference.contractVersion,
    reference.source ?? '',
    reference.documentId ?? '',
    reference.url ?? '',
    reference.issuer ?? '',
    reference.uf ?? '',
  ].join('|')
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}
