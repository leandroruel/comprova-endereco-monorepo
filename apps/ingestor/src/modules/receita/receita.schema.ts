/** Ordem das colunas do CSV de estabelecimentos da Receita Federal (separado por `;`). */
export const ESTABELECIMENTO_COLUMNS = [
  'cnpj_basico',
  'cnpj_ordem',
  'cnpj_dv',
  'matriz_filial',
  'nome_fantasia',
  'situacao_cadastral',
  'data_situacao',
  'motivo_situacao',
  'nome_cidade_exterior',
  'pais',
  'data_inicio_atividade',
  'cnae_fiscal_principal',
  'cnae_fiscal_secundario',
  'tipo_logradouro',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cep',
  'uf',
  'municipio',
  'ddd1',
  'telefone1',
  'ddd2',
  'telefone2',
  'situacao_especial',
  'data_situacao_especial',
  'email',
] as const

export interface EstabelecimentoRowValues {
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
  readonly buildingKey: Buffer | null
  readonly unitKey: Buffer | null
  readonly snapshotMonth: string
}

export interface IngestStats {
  readonly rows: number
  readonly snapshotMonth: string
  readonly elapsedMs: number
}
