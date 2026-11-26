import type { Verdict } from './policy.js'

/**
 * Vereditos elegíveis para emissão de credencial (VC).
 *
 * Apenas validações com resultado conclusivo e positivo geram credencial.
 * Vereditos negativos, inconclusivos ou de inconsistência NÃO emitem.
 */
export const ELIGIBLE_VERDICTS: ReadonlySet<Verdict> = new Set([
  'CONFIRMED_COMMERCIAL',
  'SHARED_VIRTUAL',
  'OCCUPIED_BY_OTHER_ENTITY',
  'RESIDENTIAL',
])

/**
 * Verifica se um veredito é elegível para emissão de credencial.
 */
export const isEligibleForCredential = (verdict: Verdict | null): boolean =>
  verdict !== null && ELIGIBLE_VERDICTS.has(verdict)

/**
 * Política centralizada de elegibilidade para emissão de credencial.
 *
 * Requisitos (todos devem ser satisfeitos):
 * 1. Validation está em status 'completed' (já garantido pelo caller)
 * 2. Veredito está em ELIGIBLE_VERDICTS
 * 3. Validation tem completedAt (timestamp de conclusão)
 * 4. Tenant tem chave de assinatura ativa
 * 5. Não há disputa/contestação ativa na validação
 *
 * Esta função é pura e não acessa banco; as verificações de banco
 * (chave de assinatura, contestação) são delegadas ao caller.
 */
export interface EligibilityCheckResult {
  readonly eligible: boolean
  readonly reason: string | null
}

export const checkCredentialEligibility = (
  verdict: Verdict | null,
  completedAt: Date | null,
  hasActiveSigningKey: boolean,
  isContested: boolean,
): EligibilityCheckResult => {
  if (verdict === null) {
    return { eligible: false, reason: 'verdict_null' }
  }
  if (!ELIGIBLE_VERDICTS.has(verdict)) {
    return { eligible: false, reason: `verdict_not_eligible:${verdict}` }
  }
  if (completedAt === null) {
    return { eligible: false, reason: 'completed_at_missing' }
  }
  if (!hasActiveSigningKey) {
    return { eligible: false, reason: 'no_active_signing_key' }
  }
  if (isContested) {
    return { eligible: false, reason: 'validation_contested' }
  }
  return { eligible: true, reason: null }
}
