import { and, eq, ne, sql } from 'drizzle-orm'
import type {
  CnaeCategoria,
  CepReader,
  CepRecord,
  CnefeReader,
  EstabelecimentoRecord,
  KnownSharedReader,
  OtherActiveCnpj,
  ProfileReader,
  RegistryReader,
} from '@comprova/core'
import type { Db } from './client.js'
import * as t from './schema.js'

const toEstabelecimento = (row: typeof t.refReceitaEstabelecimento.$inferSelect): EstabelecimentoRecord => ({
  cnpjBasico: row.cnpjBasico,
  cnpjOrdem: row.cnpjOrdem,
  cnpjDv: row.cnpjDv,
  matrizFilial: row.matrizFilial,
  nomeFantasia: row.nomeFantasia,
  situacaoCadastral: row.situacaoCadastral,
  dataSituacao: row.dataSituacao,
  motivoSituacao: row.motivoSituacao,
  dataAbertura: row.dataAbertura,
  cnaePrincipal: row.cnaePrincipal,
  cnaesSecundarios: row.cnaesSecundarios,
  tipoLogradouro: row.tipoLogradouro,
  logradouro: row.logradouro,
  numero: row.numero,
  complemento: row.complemento,
  bairro: row.bairro,
  cep: row.cep,
  uf: row.uf,
  municipioReceita: row.municipioReceita,
  municipioIbge: row.municipioIbge,
  paisCodigo: row.paisCodigo,
  cidadeExterior: row.cidadeExterior,
  buildingKey: row.buildingKey === null ? null : Buffer.from(row.buildingKey),
  unitKey: row.unitKey === null ? null : Buffer.from(row.unitKey),
})

export const makeRegistryReader = (db: Db): RegistryReader => ({
  getEstabelecimento: async ({ basico, ordem, dv }) => {
    const rows = await db
      .select()
      .from(t.refReceitaEstabelecimento)
      .where(
        and(
          eq(t.refReceitaEstabelecimento.cnpjBasico, basico),
          eq(t.refReceitaEstabelecimento.cnpjOrdem, ordem),
          eq(t.refReceitaEstabelecimento.cnpjDv, dv),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : toEstabelecimento(row)
  },
})

export const makeCnefeReader = (db: Db): CnefeReader => ({
  findAddress: async ({ municipioIbge, logradouroNorm, numero }) => {
    if (numero.length > 0) {
      const exact = await db
        .select({
          cnefeId: t.refCnefeAddress.cnefeId,
          especie: t.refCnefeAddress.especie,
          cep: t.refCnefeAddress.cep,
        })
        .from(t.refCnefeAddress)
        .where(
          and(
            eq(t.refCnefeAddress.municipioIbge, municipioIbge),
            sql`${t.refCnefeAddress.logradouroNorm} = ${logradouroNorm}`,
            sql`${t.refCnefeAddress.numero} = ${numero}`,
          ),
        )
        .limit(1)
      const row = exact[0]
      if (row !== undefined) {
        return { cnefeId: row.cnefeId, especie: row.especie, cep: row.cep, exactNumber: true }
      }
    }
    const streetOnly = await db
      .select({
        cnefeId: t.refCnefeAddress.cnefeId,
        especie: t.refCnefeAddress.especie,
        cep: t.refCnefeAddress.cep,
      })
      .from(t.refCnefeAddress)
      .where(
        and(
          eq(t.refCnefeAddress.municipioIbge, municipioIbge),
          sql`${t.refCnefeAddress.logradouroNorm} = ${logradouroNorm}`,
        ),
      )
      .limit(1)
    const row = streetOnly[0]
    return row === undefined
      ? null
      : { cnefeId: row.cnefeId, especie: row.especie, cep: row.cep, exactNumber: false }
  },
})

export const makeCepReader = (db: Db): CepReader => ({
  get: async (cep: string): Promise<CepRecord | null> => {
    const rows = await db.select().from(t.refCep).where(eq(t.refCep.cep, cep)).limit(1)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          uf: row.uf,
          municipioIbge: row.municipioIbge,
          localidade: row.localidade,
          bairro: row.bairro,
          logradouroNorm: row.logradouroNorm,
        }
  },
})

export const makeProfileReader = (db: Db): ProfileReader => ({
  getProfile: async (buildingKey: Uint8Array) => {
    const rows = await db
      .select({
        activeCnpjCount: t.addressProfile.activeCnpjCount,
        activeMatrizCount: t.addressProfile.activeMatrizCount,
        distinctCnaeDiv: t.addressProfile.distinctCnaeDiv,
        distinctPartnerCount: t.addressProfile.distinctPartnerCount,
        topPartnerShare: t.addressProfile.topPartnerShare,
        isKnownShared: t.addressProfile.isKnownShared,
        sharedKind: t.addressProfile.sharedKind,
        openedLast12m: t.addressProfile.openedLast12m,
      })
      .from(t.addressProfile)
      .innerJoin(t.canonicalAddress, eq(t.addressProfile.addressId, t.canonicalAddress.addressId))
      .where(eq(t.canonicalAddress.buildingKey, Buffer.from(buildingKey)))
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
        cnpjBasico: t.refReceitaEstabelecimento.cnpjBasico,
        cnpjOrdem: t.refReceitaEstabelecimento.cnpjOrdem,
        nomeFantasia: t.refReceitaEstabelecimento.nomeFantasia,
        cnaePrincipal: t.refReceitaEstabelecimento.cnaePrincipal,
        matrizFilial: t.refReceitaEstabelecimento.matrizFilial,
      })
      .from(t.refReceitaEstabelecimento)
      .where(
        and(
          eq(t.refReceitaEstabelecimento.buildingKey, Buffer.from(buildingKey)),
          eq(t.refReceitaEstabelecimento.situacaoCadastral, 2),
          ne(t.refReceitaEstabelecimento.cnpjBasico, excludeBasico),
        ),
      )
      .limit(10),
})

export const makeKnownSharedReader = (db: Db): KnownSharedReader => ({
  get: async (buildingKey: Uint8Array) => {
    const rows = await db
      .select({ kind: t.refKnownSharedAddress.kind })
      .from(t.refKnownSharedAddress)
      .where(eq(t.refKnownSharedAddress.buildingKey, Buffer.from(buildingKey)))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : { kind: row.kind }
  },
})

export const makeCnaeCategoriaReader = (db: Db) => ({
  categoriaForDivisao: async (divisao: string): Promise<CnaeCategoria> => {
    const rows = await db
      .select({ categoria: t.refCnaeDivisaoCategoria.categoria })
      .from(t.refCnaeDivisaoCategoria)
      .where(eq(t.refCnaeDivisaoCategoria.divisao, divisao))
      .limit(1)
    const row = rows[0]
    return (row?.categoria as CnaeCategoria | undefined) ?? 'MIXED'
  },
})
