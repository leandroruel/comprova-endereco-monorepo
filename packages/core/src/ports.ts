export interface EstabelecimentoRecord {
  readonly cnpjBasico: string
  readonly cnpjOrdem: string
  readonly cnpjDv: string
  readonly matrizFilial: number
  readonly nomeFantasia: string | null
  readonly situacaoCadastral: number
  readonly dataSituacao: string | null
  readonly motivoSituacao: number | null
  readonly dataAbertura: string | null
  readonly cnaePrincipal: string | null
  readonly cnaesSecundarios: readonly string[] | null
  readonly tipoLogradouro: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly bairro: string | null
  readonly cep: string | null
  readonly uf: string | null
  readonly municipioReceita: number | null
  readonly municipioIbge: number | null
  readonly paisCodigo: number | null
  readonly cidadeExterior: string | null
  readonly telefone: string | null
  readonly emailDomain: string | null
  readonly buildingKey: Uint8Array | null
  readonly unitKey: Uint8Array | null
}

export interface CnefeMatch {
  readonly cnefeId: number
  readonly especie: number | null
  readonly cep: string | null
  readonly exactNumber: boolean
}

export interface CepRecord {
  readonly uf: string
  readonly municipioIbge: number | null
  readonly localidade: string | null
  readonly bairro: string | null
  readonly logradouroNorm: string | null
}

export interface AddressProfileRecord {
  readonly activeCnpjCount: number
  readonly activeMatrizCount: number
  readonly distinctCnaeDiv: number
  readonly distinctPartnerCount: number
  readonly topPartnerShare: number | null
  readonly isKnownShared: boolean
  readonly sharedKind: string | null
  readonly openedLast12m: number
}

export interface OtherActiveCnpj {
  readonly cnpjBasico: string
  readonly cnpjOrdem: string
  readonly nomeFantasia: string | null
  readonly cnaePrincipal: string | null
  readonly matrizFilial: number
}

export type CnaeCategoria =
  'RESIDENTIAL_COMPATIBLE' | 'COMMERCIAL' | 'INDUSTRIAL' | 'AGRICULTURAL' | 'PUBLIC_SERVICES' | 'MIXED'

export interface RegistryReader {
  readonly getEstabelecimento: (cnpj: {
    readonly basico: string
    readonly ordem: string
    readonly dv: string
  }) => Promise<EstabelecimentoRecord | null>
}

export interface CnefeReader {
  readonly findAddress: (query: {
    readonly municipioIbge: number
    readonly logradouroNorm: string
    readonly numero: string
  }) => Promise<CnefeMatch | null>
}

export interface CepReader {
  readonly get: (cep: string) => Promise<CepRecord | null>
}

export interface ProfileReader {
  readonly getProfile: (buildingKey: Uint8Array) => Promise<AddressProfileRecord | null>
  readonly getOtherActiveCnpjs: (
    buildingKey: Uint8Array,
    excludeBasico: string,
  ) => Promise<readonly OtherActiveCnpj[]>
}

export interface KnownSharedReader {
  readonly get: (buildingKey: Uint8Array) => Promise<{ readonly kind: string } | null>
}

export interface CnaeCategoriaReader {
  readonly categoriaForDivisao: (divisao: string) => Promise<CnaeCategoria>
}

export interface GeoCoord {
  readonly lat: number
  readonly lon: number
}

export interface PartnerGraphStats {
  readonly coLocatedCnpjs: number
  readonly cnpjsSharingPartner: number
  readonly recentOpeningsAtAddress: number
  readonly hasData: boolean
}

export interface PartnerGraphReader {
  readonly statsFor: (query: {
    readonly buildingKey: Uint8Array
    readonly cnpjBasico: string
  }) => Promise<PartnerGraphStats>
}

export interface CnefeCoordReader {
  readonly coordFor: (query: {
    readonly municipioIbge: number
    readonly logradouroNorm: string
    readonly numero: string
  }) => Promise<GeoCoord | null>
}
