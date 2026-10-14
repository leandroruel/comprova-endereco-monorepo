import { addressKeys, canonicalizeAddress, type CnaeCategoria } from '@comprova/core'
import { type Db } from '@comprova/db'
import { sql } from '@comprova/db'
import * as t from '@comprova/db'

export const CNAE_CATEGORIAS: ReadonlyArray<{ readonly divisao: string; readonly categoria: CnaeCategoria }> =
  [
    { divisao: '01', categoria: 'AGRICULTURAL' },
    { divisao: '02', categoria: 'AGRICULTURAL' },
    { divisao: '03', categoria: 'AGRICULTURAL' },
    { divisao: '05', categoria: 'INDUSTRIAL' },
    { divisao: '06', categoria: 'INDUSTRIAL' },
    { divisao: '07', categoria: 'INDUSTRIAL' },
    { divisao: '08', categoria: 'INDUSTRIAL' },
    { divisao: '09', categoria: 'INDUSTRIAL' },
    { divisao: '10', categoria: 'INDUSTRIAL' },
    { divisao: '11', categoria: 'INDUSTRIAL' },
    { divisao: '12', categoria: 'INDUSTRIAL' },
    { divisao: '13', categoria: 'INDUSTRIAL' },
    { divisao: '14', categoria: 'INDUSTRIAL' },
    { divisao: '15', categoria: 'INDUSTRIAL' },
    { divisao: '16', categoria: 'INDUSTRIAL' },
    { divisao: '17', categoria: 'INDUSTRIAL' },
    { divisao: '18', categoria: 'INDUSTRIAL' },
    { divisao: '19', categoria: 'INDUSTRIAL' },
    { divisao: '20', categoria: 'INDUSTRIAL' },
    { divisao: '21', categoria: 'INDUSTRIAL' },
    { divisao: '22', categoria: 'INDUSTRIAL' },
    { divisao: '23', categoria: 'INDUSTRIAL' },
    { divisao: '24', categoria: 'INDUSTRIAL' },
    { divisao: '25', categoria: 'INDUSTRIAL' },
    { divisao: '26', categoria: 'INDUSTRIAL' },
    { divisao: '27', categoria: 'INDUSTRIAL' },
    { divisao: '28', categoria: 'INDUSTRIAL' },
    { divisao: '29', categoria: 'INDUSTRIAL' },
    { divisao: '30', categoria: 'INDUSTRIAL' },
    { divisao: '31', categoria: 'INDUSTRIAL' },
    { divisao: '32', categoria: 'INDUSTRIAL' },
    { divisao: '33', categoria: 'INDUSTRIAL' },
    { divisao: '35', categoria: 'INDUSTRIAL' },
    { divisao: '36', categoria: 'INDUSTRIAL' },
    { divisao: '37', categoria: 'INDUSTRIAL' },
    { divisao: '38', categoria: 'INDUSTRIAL' },
    { divisao: '39', categoria: 'INDUSTRIAL' },
    { divisao: '41', categoria: 'INDUSTRIAL' },
    { divisao: '42', categoria: 'INDUSTRIAL' },
    { divisao: '43', categoria: 'INDUSTRIAL' },
    { divisao: '45', categoria: 'COMMERCIAL' },
    { divisao: '46', categoria: 'COMMERCIAL' },
    { divisao: '47', categoria: 'COMMERCIAL' },
    { divisao: '49', categoria: 'COMMERCIAL' },
    { divisao: '50', categoria: 'COMMERCIAL' },
    { divisao: '51', categoria: 'COMMERCIAL' },
    { divisao: '52', categoria: 'COMMERCIAL' },
    { divisao: '53', categoria: 'COMMERCIAL' },
    { divisao: '55', categoria: 'COMMERCIAL' },
    { divisao: '56', categoria: 'COMMERCIAL' },
    { divisao: '58', categoria: 'COMMERCIAL' },
    { divisao: '59', categoria: 'COMMERCIAL' },
    { divisao: '60', categoria: 'COMMERCIAL' },
    { divisao: '61', categoria: 'COMMERCIAL' },
    { divisao: '63', categoria: 'COMMERCIAL' },
    { divisao: '64', categoria: 'COMMERCIAL' },
    { divisao: '65', categoria: 'COMMERCIAL' },
    { divisao: '66', categoria: 'COMMERCIAL' },
    { divisao: '68', categoria: 'COMMERCIAL' },
    { divisao: '62', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '69', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '70', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '71', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '72', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '73', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '74', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '75', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '77', categoria: 'MIXED' },
    { divisao: '78', categoria: 'MIXED' },
    { divisao: '79', categoria: 'MIXED' },
    { divisao: '81', categoria: 'MIXED' },
    { divisao: '82', categoria: 'MIXED' },
    { divisao: '80', categoria: 'COMMERCIAL' },
    { divisao: '84', categoria: 'PUBLIC_SERVICES' },
    { divisao: '85', categoria: 'MIXED' },
    { divisao: '86', categoria: 'MIXED' },
    { divisao: '87', categoria: 'PUBLIC_SERVICES' },
    { divisao: '88', categoria: 'MIXED' },
    { divisao: '90', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '91', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '93', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '94', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '95', categoria: 'RESIDENTIAL_COMPATIBLE' },
    { divisao: '96', categoria: 'RESIDENTIAL_COMPATIBLE' },
  ]

export interface GoldenCase {
  readonly label: string
  readonly cnpj: string
  readonly expectedVerdict:
    | 'CONFIRMED_COMMERCIAL'
    | 'SHARED_VIRTUAL'
    | 'OCCUPIED_BY_OTHER_ENTITY'
    | 'RESIDENTIAL'
    | 'NOT_FOUND'
    | 'FOREIGN'
    | 'INCONSISTENT'
    | 'INSUFFICIENT_EVIDENCE'
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  { label: 'comercio-confirmado', cnpj: '12345678000195', expectedVerdict: 'CONFIRMED_COMMERCIAL' },
  { label: 'escritorio-contabil', cnpj: '23456789000195', expectedVerdict: 'SHARED_VIRTUAL' },
  { label: 'ocupado-por-outro', cnpj: '34567890000130', expectedVerdict: 'OCCUPIED_BY_OTHER_ENTITY' },
  { label: 'mei-residencial', cnpj: '56789012000100', expectedVerdict: 'RESIDENTIAL' },
  { label: 'endereco-exterior', cnpj: '67890123000116', expectedVerdict: 'FOREIGN' },
  { label: 'cep-inexistente', cnpj: '78901234000105', expectedVerdict: 'NOT_FOUND' },
  { label: 'cnpj-baixado', cnpj: '89012345000179', expectedVerdict: 'INCONSISTENT' },
  { label: 'sem-base-local', cnpj: '90123456000131', expectedVerdict: 'INSUFFICIENT_EVIDENCE' },
]

interface EstabSeed {
  readonly basico: string
  readonly ordem: string
  readonly dv: string
  readonly matrizFilial: number
  readonly nomeFantasia: string | null
  readonly situacao: number
  readonly cnaePrincipal: string | null
  readonly tipoLogradouro: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly bairro: string | null
  readonly cep: string | null
  readonly uf: string | null
  readonly municipioIbge: number | null
  readonly paisCodigo: number | null
  readonly cidadeExterior: string | null
}

const buildingKeyOfSeed = (seed: EstabSeed): Buffer =>
  addressKeys(
    canonicalizeAddress({
      tipoLogradouro: seed.tipoLogradouro,
      logradouro: seed.logradouro,
      numero: seed.numero,
      complemento: seed.complemento,
      bairro: seed.bairro,
      cep: seed.cep,
      uf: seed.uf,
      municipioIbge: seed.municipioIbge,
      countryCode: seed.paisCodigo !== null && seed.paisCodigo !== 105 ? 'XX' : 'BR',
    }),
  ).buildingKey

const ESTABELECIMENTOS: readonly EstabSeed[] = [
  {
    basico: '12345678',
    ordem: '0001',
    dv: '95',
    matrizFilial: 1,
    nomeFantasia: 'Loja das Flores',
    situacao: 2,
    cnaePrincipal: '4711301',
    tipoLogradouro: 'R.',
    logradouro: 'das Flores',
    numero: '100',
    complemento: null,
    bairro: 'Centro',
    cep: '01310100',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
  {
    basico: '23456789',
    ordem: '0001',
    dv: '95',
    matrizFilial: 1,
    nomeFantasia: 'Contabilidade Central',
    situacao: 2,
    cnaePrincipal: '6920601',
    tipoLogradouro: 'AV.',
    logradouro: 'Central',
    numero: 'S/N',
    complemento: 'Sala 10',
    bairro: 'Centro',
    cep: '01310200',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
  {
    basico: '34567890',
    ordem: '0001',
    dv: '30',
    matrizFilial: 1,
    nomeFantasia: 'Papelaria do Bairro',
    situacao: 2,
    cnaePrincipal: '4761001',
    tipoLogradouro: 'RUA',
    logradouro: 'do Comercio',
    numero: '200',
    complemento: null,
    bairro: 'Centro',
    cep: '01310300',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
  {
    basico: '45678901',
    ordem: '0001',
    dv: '75',
    matrizFilial: 1,
    nomeFantasia: 'Padaria do Ze',
    situacao: 2,
    cnaePrincipal: '4712100',
    tipoLogradouro: 'RUA',
    logradouro: 'do Comercio',
    numero: '200',
    complemento: null,
    bairro: 'Centro',
    cep: '01310300',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
  {
    basico: '56789012',
    ordem: '0001',
    dv: '00',
    matrizFilial: 1,
    nomeFantasia: 'Studio Beleza',
    situacao: 2,
    cnaePrincipal: '9602501',
    tipoLogradouro: 'R.',
    logradouro: 'da Casa',
    numero: '50',
    complemento: null,
    bairro: 'Jardim',
    cep: '01310400',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
  {
    basico: '67890123',
    ordem: '0001',
    dv: '16',
    matrizFilial: 1,
    nomeFantasia: 'Brazil Trading LLC',
    situacao: 2,
    cnaePrincipal: '4651602',
    tipoLogradouro: null,
    logradouro: 'Biscayne Boulevard',
    numero: '801',
    complemento: null,
    bairro: null,
    cep: null,
    uf: null,
    municipioIbge: null,
    paisCodigo: 246,
    cidadeExterior: 'MIAMI',
  },
  {
    basico: '78901234',
    ordem: '0001',
    dv: '05',
    matrizFilial: 1,
    nomeFantasia: 'Distribuidora Fantasma',
    situacao: 2,
    cnaePrincipal: '4637199',
    tipoLogradouro: 'R.',
    logradouro: 'Nao Existe',
    numero: '999',
    complemento: null,
    bairro: 'Centro',
    cep: '99999999',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
  {
    basico: '89012345',
    ordem: '0001',
    dv: '79',
    matrizFilial: 1,
    nomeFantasia: 'Varejo Encerrado',
    situacao: 8,
    cnaePrincipal: '4751201',
    tipoLogradouro: 'R.',
    logradouro: 'das Flores',
    numero: '150',
    complemento: null,
    bairro: 'Centro',
    cep: '01310100',
    uf: 'SP',
    municipioIbge: 3550308,
    paisCodigo: null,
    cidadeExterior: null,
  },
]

const point = (lon: string, lat: string) => sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`

export const seedGoldenDataset = async (db: Db): Promise<void> => {
  await db
    .insert(t.refCnaeDivisaoCategoria)
    .values(CNAE_CATEGORIAS.map((c) => ({ divisao: c.divisao, categoria: c.categoria })))
    .onConflictDoNothing()

  await db
    .insert(t.refCep)
    .values([
      {
        cep: '01310100',
        uf: 'SP',
        municipioIbge: 3550308,
        localidade: 'Sao Paulo',
        bairro: 'Bela Vista',
        logradouroNorm: 'RUA DAS FLORES',
        source: 'golden',
      },
      {
        cep: '01310200',
        uf: 'SP',
        municipioIbge: 3550308,
        localidade: 'Sao Paulo',
        bairro: 'Centro',
        logradouroNorm: 'AVENIDA CENTRAL',
        source: 'golden',
      },
      {
        cep: '01310300',
        uf: 'SP',
        municipioIbge: 3550308,
        localidade: 'Sao Paulo',
        bairro: 'Centro',
        logradouroNorm: 'RUA DO COMERCIO',
        source: 'golden',
      },
      {
        cep: '01310400',
        uf: 'SP',
        municipioIbge: 3550308,
        localidade: 'Sao Paulo',
        bairro: 'Jardim',
        logradouroNorm: 'RUA DA CASA',
        source: 'golden',
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(t.refCnefeAddress)
    .values([
      {
        cnefeId: 1,
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310100',
        logradouroNorm: 'RUA DAS FLORES',
        numero: '100',
        complementoNorm: null,
        especie: 6,
        geom: point('-46.65', '-23.56'),
        censusYear: 2022,
      },
      {
        cnefeId: 2,
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310200',
        logradouroNorm: 'AVENIDA CENTRAL',
        numero: 'S/N',
        complementoNorm: null,
        especie: 6,
        geom: point('-46.66', '-23.57'),
        censusYear: 2022,
      },
      {
        cnefeId: 3,
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310300',
        logradouroNorm: 'RUA DO COMERCIO',
        numero: '200',
        complementoNorm: null,
        especie: 6,
        geom: point('-46.64', '-23.55'),
        censusYear: 2022,
      },
      {
        cnefeId: 4,
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310400',
        logradouroNorm: 'RUA DA CASA',
        numero: '50',
        complementoNorm: null,
        especie: 1,
        geom: point('-46.63', '-23.58'),
        censusYear: 2022,
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(t.refReceitaEstabelecimento)
    .values(
      ESTABELECIMENTOS.map((seed) => ({
        cnpjBasico: seed.basico,
        cnpjOrdem: seed.ordem,
        cnpjDv: seed.dv,
        matrizFilial: seed.matrizFilial,
        nomeFantasia: seed.nomeFantasia,
        situacaoCadastral: seed.situacao,
        dataSituacao: seed.situacao === 8 ? '2024-01-15' : null,
        motivoSituacao: seed.situacao === 8 ? 60 : null,
        dataAbertura: '2020-03-10',
        cnaePrincipal: seed.cnaePrincipal,
        cnaesSecundarios: null,
        tipoLogradouro: seed.tipoLogradouro,
        logradouro: seed.logradouro,
        numero: seed.numero,
        complemento: seed.complemento,
        bairro: seed.bairro,
        cep: seed.cep,
        uf: seed.uf,
        municipioReceita: 7107,
        municipioIbge: seed.municipioIbge,
        paisCodigo: seed.paisCodigo,
        cidadeExterior: seed.cidadeExterior,
        telefone: null,
        emailDomain: null,
        buildingKey: seed.cep === null && seed.uf === null ? null : buildingKeyOfSeed(seed),
        unitKey: seed.cep === null && seed.uf === null ? null : buildingKeyOfSeed(seed),
        snapshotMonth: '2026-09-01',
      })),
    )
    .onConflictDoNothing()

  const contabilidadeKey = buildingKeyOfSeed(ESTABELECIMENTOS[1] as EstabSeed)
  const comercioKey = buildingKeyOfSeed(ESTABELECIMENTO_AT_INDEX_2())

  const addressRows = await db
    .insert(t.canonicalAddress)
    .values([
      {
        addressId: crypto.randomUUID(),
        buildingKey: contabilidadeKey,
        countryCode: 'BR',
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310200',
        logradouroNorm: 'AVENIDA CENTRAL',
        numero: 'S/N',
        bairroNorm: 'CENTRO',
      },
      {
        addressId: crypto.randomUUID(),
        buildingKey: comercioKey,
        countryCode: 'BR',
        uf: 'SP',
        municipioIbge: 3550308,
        cep: '01310300',
        logradouroNorm: 'RUA DO COMERCIO',
        numero: '200',
        bairroNorm: 'CENTRO',
      },
    ])
    .onConflictDoNothing()
    .returning({ addressId: t.canonicalAddress.addressId, cep: t.canonicalAddress.cep })

  const contabilidadeAddress = addressRows.find((r) => r.cep === '01310200')
  const comercioAddress = addressRows.find((r) => r.cep === '01310300')

  if (contabilidadeAddress !== undefined) {
    await db
      .insert(t.addressProfile)
      .values({
        addressId: contabilidadeAddress.addressId,
        activeCnpjCount: 15,
        activeMatrizCount: 9,
        distinctCnaeDiv: 8,
        distinctPartnerCount: 12,
        topPartnerShare: 0.6,
        isKnownShared: false,
        sharedKind: null,
        openedLast12m: 2,
        computedFromSnapshot: '2026-09-01',
      })
      .onConflictDoNothing()
    await db
      .insert(t.refKnownSharedAddress)
      .values({ buildingKey: contabilidadeKey, kind: 'accounting_office', source: 'golden' })
      .onConflictDoNothing()
  }

  if (comercioAddress !== undefined) {
    await db
      .insert(t.addressProfile)
      .values({
        addressId: comercioAddress.addressId,
        activeCnpjCount: 2,
        activeMatrizCount: 2,
        distinctCnaeDiv: 2,
        distinctPartnerCount: 2,
        topPartnerShare: null,
        isKnownShared: false,
        sharedKind: null,
        openedLast12m: 0,
        computedFromSnapshot: '2026-09-01',
      })
      .onConflictDoNothing()
  }
}

const ESTABELECIMENTO_AT_INDEX_2 = (): EstabSeed => ESTABELECIMENTOS[2] as EstabSeed
