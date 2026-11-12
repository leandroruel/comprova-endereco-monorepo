import { addressProfile, canonicalAddress } from './addresses.js'
import { authAccount, adminAuthAccount, adminAuthSession, adminAuthUser, adminAuthVerification, authSession, authUser, authVerification, verifierAuthAccount, verifierAuthSession, verifierAuthUser, verifierAuthVerification } from './auth.js'
import { batch, batchItem } from './batches.js'
import { addressSignalCache, claim, claimEvidence, signal } from './claims.js'
import { evidence } from './evidence.js'
import { evidenceArtifact } from './evidence-artifact.js'
import { evidenceAnalysis } from './evidence-analysis.js'
import { evidenceVerificationAttempt } from './evidence-verification.js'
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
import { organizationInvitation, organizationMember } from './organizations.js'
import { auditLog, tenantQuotaAudit, usageBillingUnit, usageEvent, usageEventIdempotency } from './usage.js'
import { validation, validationIdempotency } from './validations.js'
import { holder } from './holder.js'
import { holderInformationRequest } from './holder-information-request.js'
import { holderInformationRequestEvent } from './holder-information-request-event.js'
import { holderAccessToken } from './holder-access-token.js'
import { holderItemResponse } from './holder-item-response.js'
import { holderInformationRequestDocument } from './holder-information-request-document.js'
import { holderSubmissionProcessing } from './holder-submission-processing.js'
import { kycProcess, kycEvent } from './kyc.js'
export * from './enums.js'
export * from './holder-submission-processing.js'
export * from './tenancy.js'
export * from './organizations.js'
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
export * from './evidence-analysis.js'
export * from './evidence-verification.js'
export * from './events.js'
export * from './usage.js'
export * from './batches.js'
export * from './holder.js'
export * from './holder-information-request.js'
export * from './holder-information-request-event.js'
export * from './holder-access-token.js'
export * from './holder-item-response.js'
export * from './holder-information-request-document.js'
export * from './kyc.js'

/**
 * Mapa canônico de tabelas para o Drizzle (`drizzle(client, { schema })`) e
 * para quem precisa iterar o modelo. É explícito de propósito: um registro
 * novo entra aqui de forma revisável, sem espalhar objetos de módulo que não
 * são tabelas.
 */
export const schema = {
  tenant,
  apiKey,
  organizationMember,
  organizationInvitation,
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
  adminAuthUser,
  adminAuthSession,
  adminAuthAccount,
  adminAuthVerification,
  verifierAuthUser,
  verifierAuthSession,
  verifierAuthAccount,
  verifierAuthVerification,
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
  evidenceAnalysis,
  evidenceVerificationAttempt,
  outbox,
  webhookEndpoint,
  webhookDelivery,
  usageEvent,
  usageEventIdempotency,
  usageBillingUnit,
  tenantQuotaAudit,
  auditLog,
  holder,
  holderInformationRequest,
  holderInformationRequestEvent,
  holderAccessToken,
  holderItemResponse,
  holderInformationRequestDocument,
  holderSubmissionProcessing,
  kycProcess,
  kycEvent,
  batch,
  batchItem,
} as const
