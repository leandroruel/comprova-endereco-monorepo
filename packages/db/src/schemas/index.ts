import { addressProfile, canonicalAddress } from './addresses.js'
import { authAccount, authSession, authUser, authVerification } from './auth.js'
import { batch, batchItem } from './batches.js'
import { addressSignalCache, claim, claimEvidence, signal } from './claims.js'
import { evidence } from './evidence.js'
import { evidenceArtifact } from './evidence-artifact.js'
import { outbox, webhookDelivery, webhookEndpoint } from './events.js'
import { credentialIssuance, credentialStatus, issuerSigningKey } from './issuers.js'
import {
  legalBasis,
  refCnaeDivisaoCategoria,
  refEstabelecimentoHistory,
  refReceitaEmpresa,
  refReceitaEstabelecimento,
  refReceitaMunicipio,
  refReceitaSimples,
  refReceitaSocio,
} from './reference-receita.js'
import { refCep, refCnefeAddress, refKnownSharedAddress } from './reference-address.js'
import { subject } from './subjects.js'
import { apiKey, tenant } from './tenancy.js'
import { auditLog, usageEvent } from './usage.js'
import { validation, validationIdempotency } from './validations.js'

export * from './enums.js'
export * from './tenancy.js'
export * from './issuers.js'
export * from './reference-receita.js'
export * from './reference-address.js'
export * from './auth.js'
export * from './addresses.js'
export * from './subjects.js'
export * from './validations.js'
export * from './claims.js'
export * from './evidence.js'
export * from './evidence-artifact.js'
export * from './events.js'
export * from './usage.js'
export * from './batches.js'

/**
 * Mapa canônico de tabelas para o Drizzle (`drizzle(client, { schema })`) e
 * para quem precisa iterar o modelo. É explícito de propósito: um registro
 * novo entra aqui de forma revisável, sem espalhar objetos de módulo que não
 * são tabelas.
 */
export const schema = {
  tenant,
  apiKey,
  issuerSigningKey,
  credentialStatus,
  credentialIssuance,
  legalBasis,
  refReceitaEstabelecimento,
  refReceitaEmpresa,
  refReceitaSocio,
  refReceitaSimples,
  refReceitaMunicipio,
  refCnaeDivisaoCategoria,
  refEstabelecimentoHistory,
  refCnefeAddress,
  refCep,
  refKnownSharedAddress,
  authUser,
  authSession,
  authAccount,
  authVerification,
  canonicalAddress,
  addressProfile,
  subject,
  validation,
  validationIdempotency,
  claim,
  claimEvidence,
  signal,
  addressSignalCache,
  evidence,
  evidenceArtifact,
  outbox,
  webhookEndpoint,
  webhookDelivery,
  usageEvent,
  auditLog,
  batch,
  batchItem,
} as const
