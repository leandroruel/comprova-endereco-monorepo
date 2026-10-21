import type { EstabelecimentoRecord, RegistryReader } from '@comprova/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { refReceitaEstabelecimento } from '../schemas/reference-receita.js'

const toEstabelecimento = (row: typeof refReceitaEstabelecimento.$inferSelect): EstabelecimentoRecord => ({
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
  telefone: row.telefone,
  emailDomain: row.emailDomain,
  buildingKey: row.buildingKey === null ? null : Buffer.from(row.buildingKey),
  unitKey: row.unitKey === null ? null : Buffer.from(row.unitKey),
})

/** Registry reader: estabelecimento da Receita por (básico, ordem, DV). */
export const makeRegistryReader = (db: Db): RegistryReader => ({
  getEstabelecimento: async ({ basico, ordem, dv }) => {
    const rows = await db
      .select()
      .from(refReceitaEstabelecimento)
      .where(
        and(
          eq(refReceitaEstabelecimento.cnpjBasico, basico),
          eq(refReceitaEstabelecimento.cnpjOrdem, ordem),
          eq(refReceitaEstabelecimento.cnpjDv, dv),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : toEstabelecimento(row)
  },
})
