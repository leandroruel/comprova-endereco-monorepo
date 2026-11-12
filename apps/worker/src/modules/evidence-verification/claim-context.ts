import type { AddressComparisonTarget, HolderReference } from '@comprova/core'
import { and, eq, withTenant, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import { registryRecordFromDeepContext } from '../deep-enrich/deep-enrich.registry.js'

export interface ClaimVerificationContext {
  readonly expiresAt: Date
  readonly addressTarget: AddressComparisonTarget | null
  readonly holderReference: HolderReference | null
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))

/**
 * Carrega o contexto de comparação de um claim: expiração da validation,
 * endereço canônico do alvo e referência de titular.
 *
 * A função é compartilhada pela verificação do upload (F1.3) e pela fonte
 * fiscal (F2.1). O caller que atravessa tenants usa o pool de manutenção; a
 * leitura do claim continua isolada pela RLS.
 *
 * Separação de domínios: dados operacionais (claim/validation/
 * canonical_address) são lidos dentro da transação `withTenant` com RLS.
 * Lookups de referência (`ref_receita_municipio`, `ref_receita_empresa`) são
 * leituras puras e rodam FORA da transação na conexão do database de
 * referência (`referenceDb`); sem ela, caem no `db` (comportamento
 * single-database da transição). Uma transação Drizzle nunca abrange os dois
 * databases.
 */
export const loadClaimVerificationContext = async (
  db: Db,
  tenantId: string,
  claimId: string,
  referenceDb?: Db,
): Promise<ClaimVerificationContext | null> => {
  const appContext = await withTenant(db, tenantId, async (tx) => {
    const claimRows = await tx
      .select({
        claimId: t.claim.claimId,
        validationId: t.claim.validationId,
        addressId: t.claim.addressId,
      })
      .from(t.claim)
      .where(and(eq(t.claim.claimId, claimId), eq(t.claim.tenantId, tenantId)))
      .limit(1)
    const claim = claimRows[0]
    if (claim === undefined) return null

    const validationRows = await tx
      .select({
        validationId: t.validation.validationId,
        deepContext: t.validation.deepContext,
        expiresAt: t.validation.expiresAt,
      })
      .from(t.validation)
      .where(and(eq(t.validation.validationId, claim.validationId), eq(t.validation.tenantId, tenantId)))
      .limit(1)
    const validation = validationRows[0]
    if (validation === undefined) return null

    if (claim.addressId !== null) {
      const addressRows = await tx
        .select({
          cep: t.canonicalAddress.cep,
          uf: t.canonicalAddress.uf,
          logradouroNorm: t.canonicalAddress.logradouroNorm,
          numero: t.canonicalAddress.numero,
          bairroNorm: t.canonicalAddress.bairroNorm,
          municipioIbge: t.canonicalAddress.municipioIbge,
        })
        .from(t.canonicalAddress)
        .where(eq(t.canonicalAddress.addressId, claim.addressId))
        .limit(1)
      const address = addressRows[0]
      if (address !== undefined) {
        return { validation, address }
      }
    }

    return { validation, address: null }
  })

  if (appContext === null) return null
  const { validation, address } = appContext

  const ref = referenceDb ?? db

  let addressTarget: AddressComparisonTarget | null = null
  if (address !== null) {
    let municipioNorm: string | null = null
    if (address.municipioIbge !== null) {
      const municipioRows = await ref
        .select({ nomeNorm: t.refReceitaMunicipio.nomeNorm })
        .from(t.refReceitaMunicipio)
        .where(eq(t.refReceitaMunicipio.codigoIbge, address.municipioIbge))
        .limit(1)
      municipioNorm = municipioRows[0]?.nomeNorm ?? null
    }
    addressTarget = {
      cep: address.cep,
      uf: address.uf,
      logradouroNorm: address.logradouroNorm,
      numero: address.numero,
      bairroNorm: address.bairroNorm,
      municipioNorm,
      // `canonical_address` não persiste complemento; não inventamos um.
      complementoNorm: null,
    }
  }

  const deepRegistry = registryRecordFromDeepContext(validation.deepContext ?? null)
  let holderReference: HolderReference | null = null
  if (deepRegistry !== null) {
    const cnpjBasico = deepRegistry.record.cnpjBasico
    const legalRows =
      cnpjBasico.length === 0
        ? []
        : await ref
            .select({ razaoSocial: t.refReceitaEmpresa.razaoSocial })
            .from(t.refReceitaEmpresa)
            .where(eq(t.refReceitaEmpresa.cnpjBasico, cnpjBasico))
            .limit(1)
    holderReference = {
      legalName: legalRows[0]?.razaoSocial ?? null,
      tradeName: deepRegistry.record.nomeFantasia,
    }
  }

  return {
    expiresAt: asDate(validation.expiresAt),
    addressTarget,
    holderReference,
  }
}
