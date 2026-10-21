import {
  boolean,
  char,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
} from 'drizzle-orm/pg-core'
import { bytea } from './custom-types.js'

/**
 * Base legal do tratamento (LGPD). Referenciada por validation e batch; não é
 * dado de tenant.
 */
export const legalBasis = pgTable('legal_basis', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
})

/**
 * Colunas comuns ao snapshot atual e ao histórico SCD2. A fábrica devolve
 * builders NOVOS a cada chamada: uma coluna do Drizzle pertence a uma única
 * tabela e não pode ser compartilhada entre as duas.
 */
const estabelecimentoColumns = () => ({
  cnpjBasico: char('cnpj_basico', { length: 8 }).notNull(),
  cnpjOrdem: char('cnpj_ordem', { length: 4 }).notNull(),
  cnpjDv: char('cnpj_dv', { length: 2 }).notNull(),
  matrizFilial: smallint('matriz_filial').notNull(),
  nomeFantasia: text('nome_fantasia'),
  situacaoCadastral: smallint('situacao_cadastral').notNull(),
  dataSituacao: date('data_situacao', { mode: 'string' }),
  motivoSituacao: smallint('motivo_situacao'),
  dataAbertura: date('data_abertura', { mode: 'string' }),
  cnaePrincipal: char('cnae_principal', { length: 7 }),
  cnaesSecundarios: char('cnaes_secundarios', { length: 7 }).array(),
  tipoLogradouro: text('tipo_logradouro'),
  logradouro: text('logradouro'),
  numero: text('numero'),
  complemento: text('complemento'),
  bairro: text('bairro'),
  cep: char('cep', { length: 8 }),
  uf: char('uf', { length: 2 }),
  municipioReceita: integer('municipio_receita'),
  municipioIbge: integer('municipio_ibge'),
  paisCodigo: integer('pais_codigo'),
  cidadeExterior: text('cidade_exterior'),
  telefone: text('telefone'),
  emailDomain: text('email_domain'),
  buildingKey: bytea('building_key'),
  unitKey: bytea('unit_key'),
  snapshotMonth: date('snapshot_month', { mode: 'string' }).notNull(),
})

/** Estabelecimento da Receita Federal (snapshot mensal, chave composta CNPJ). */
export const refReceitaEstabelecimento = pgTable(
  'ref_receita_estabelecimento',
  estabelecimentoColumns(),
  (t) => [primaryKey({ columns: [t.cnpjBasico, t.cnpjOrdem, t.cnpjDv] })],
)

export const refReceitaEmpresa = pgTable('ref_receita_empresa', {
  cnpjBasico: char('cnpj_basico', { length: 8 }).primaryKey(),
  razaoSocial: text('razao_social').notNull(),
  naturezaJuridica: integer('natureza_juridica'),
  capitalSocial: numeric('capital_social', { precision: 18, scale: 2 }),
  porte: smallint('porte'),
  snapshotMonth: date('snapshot_month', { mode: 'string' }).notNull(),
})

export const refReceitaSocio = pgTable(
  'ref_receita_socio',
  {
    cnpjBasico: char('cnpj_basico', { length: 8 }).notNull(),
    tipoSocio: smallint('tipo_socio').notNull(),
    nomeSocio: text('nome_socio'),
    docMascarado: text('doc_mascarado'),
    qualificacao: smallint('qualificacao'),
    dataEntrada: date('data_entrada', { mode: 'string' }),
    partnerKey: bytea('partner_key').notNull(),
    snapshotMonth: date('snapshot_month', { mode: 'string' }).notNull(),
  },
  (t) => [index('idx_socio_cnpj').on(t.cnpjBasico), index('idx_socio_partner').on(t.partnerKey)],
)

export const refReceitaSimples = pgTable('ref_receita_simples', {
  cnpjBasico: char('cnpj_basico', { length: 8 }).primaryKey(),
  opcaoSimples: boolean('opcao_simples'),
  dataOpcaoSimples: date('data_opcao_simples', { mode: 'string' }),
  dataExclusaoSimples: date('data_exclusao_simples', { mode: 'string' }),
  opcaoMei: boolean('opcao_mei'),
  dataOpcaoMei: date('data_opcao_mei', { mode: 'string' }),
  dataExclusaoMei: date('data_exclusao_mei', { mode: 'string' }),
})

export const refReceitaMunicipio = pgTable(
  'ref_receita_municipio',
  {
    codigoReceita: integer('codigo_receita').primaryKey(),
    codigoIbge: integer('codigo_ibge'),
    nomeNorm: text('nome_norm').notNull(),
    uf: char('uf', { length: 2 }),
  },
  (t) => [unique('ref_receita_municipio_nome_uf_uq').on(t.nomeNorm, t.uf)],
)

export const refCnaeDivisaoCategoria = pgTable('ref_cnae_divisao_categoria', {
  divisao: char('divisao', { length: 2 }).primaryKey(),
  categoria: text('categoria').notNull(),
})

/**
 * Histórico SCD Type 2 do estabelecimento (migração 0018). A chave inclui a
 * validade, então cada mudança de endereço gera uma linha nova.
 */
export const refEstabelecimentoHistory = pgTable(
  'ref_estabelecimento_history',
  {
    ...estabelecimentoColumns(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.cnpjBasico, t.cnpjOrdem, t.cnpjDv, t.validFrom] })],
)

export type LegalBasis = typeof legalBasis.$inferSelect
export type NewLegalBasis = typeof legalBasis.$inferInsert
export type RefReceitaEstabelecimento = typeof refReceitaEstabelecimento.$inferSelect
export type NewRefReceitaEstabelecimento = typeof refReceitaEstabelecimento.$inferInsert
export type RefReceitaEmpresa = typeof refReceitaEmpresa.$inferSelect
export type NewRefReceitaEmpresa = typeof refReceitaEmpresa.$inferInsert
export type RefReceitaSocio = typeof refReceitaSocio.$inferSelect
export type NewRefReceitaSocio = typeof refReceitaSocio.$inferInsert
export type RefReceitaSimples = typeof refReceitaSimples.$inferSelect
export type NewRefReceitaSimples = typeof refReceitaSimples.$inferInsert
export type RefReceitaMunicipio = typeof refReceitaMunicipio.$inferSelect
export type NewRefReceitaMunicipio = typeof refReceitaMunicipio.$inferInsert
export type RefCnaeDivisaoCategoria = typeof refCnaeDivisaoCategoria.$inferSelect
export type NewRefCnaeDivisaoCategoria = typeof refCnaeDivisaoCategoria.$inferInsert
export type RefEstabelecimentoHistory = typeof refEstabelecimentoHistory.$inferSelect
export type NewRefEstabelecimentoHistory = typeof refEstabelecimentoHistory.$inferInsert
