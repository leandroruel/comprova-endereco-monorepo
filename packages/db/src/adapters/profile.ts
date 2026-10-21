import type { OtherActiveCnpj, ProfileReader } from '@comprova/core'
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../client.js'
import { addressProfile, canonicalAddress } from '../schemas/addresses.js'
import { refReceitaEstabelecimento } from '../schemas/reference-receita.js'

/** Perfil agregado do endereço + CNPJs ativos vizinhos (fast path). */
export const makeProfileReader = (db: Db): ProfileReader => ({
  getProfile: async (buildingKey: Uint8Array) => {
    const rows = await db
      .select({
        activeCnpjCount: addressProfile.activeCnpjCount,
        activeMatrizCount: addressProfile.activeMatrizCount,
        distinctCnaeDiv: addressProfile.distinctCnaeDiv,
        distinctPartnerCount: addressProfile.distinctPartnerCount,
        topPartnerShare: addressProfile.topPartnerShare,
        isKnownShared: addressProfile.isKnownShared,
        sharedKind: addressProfile.sharedKind,
        openedLast12m: addressProfile.openedLast12m,
      })
      .from(addressProfile)
      .innerJoin(canonicalAddress, eq(addressProfile.addressId, canonicalAddress.addressId))
      .where(eq(canonicalAddress.buildingKey, Buffer.from(buildingKey)))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : row
  },
  getOtherActiveCnpjs: async (
    buildingKey: Uint8Array,
    excludeBasico: string,
  ): Promise<readonly OtherActiveCnpj[]> =>
    db
      .select({
        cnpjBasico: refReceitaEstabelecimento.cnpjBasico,
        cnpjOrdem: refReceitaEstabelecimento.cnpjOrdem,
        nomeFantasia: refReceitaEstabelecimento.nomeFantasia,
        cnaePrincipal: refReceitaEstabelecimento.cnaePrincipal,
        matrizFilial: refReceitaEstabelecimento.matrizFilial,
      })
      .from(refReceitaEstabelecimento)
      .where(
        and(
          eq(refReceitaEstabelecimento.buildingKey, Buffer.from(buildingKey)),
          eq(refReceitaEstabelecimento.situacaoCadastral, 2),
          ne(refReceitaEstabelecimento.cnpjBasico, excludeBasico),
        ),
      )
      .limit(10),
})
