import { addressKeys, canonicalizeAddress, normalizeText } from '@comprova/core'
import type { EstabelecimentoRowValues } from './receita.schema.js'

const unquote = (field: string): string => field.replace(/^"|"$/g, '')

interface LineState {
  readonly fields: readonly string[]
  readonly current: string
  readonly inQuotes: boolean
}

/**
 * Divide uma linha por `;` respeitando aspas: dentro de aspas o separador não
 * conta, e cada campo perde as aspas externas. Expresso como redução sobre os
 * caracteres — sem `let` nem índice mutável.
 */
export const parseLine = (line: string): readonly string[] => {
  const state = [...line].reduce<LineState>(
    (acc, char) => {
      if (char === '"') return { ...acc, inQuotes: !acc.inQuotes }
      if (char === ';' && !acc.inQuotes) {
        return { fields: [...acc.fields, unquote(acc.current)], current: '', inQuotes: acc.inQuotes }
      }
      return { ...acc, current: acc.current + char }
    },
    { fields: [], current: '', inQuotes: false },
  )
  return [...state.fields, unquote(state.current)]
}

const toIsoDate = (raw: string): string | null => {
  const digits = raw.replace(/\D+/g, '')
  if (digits.length !== 8) return null
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

const digitsOnly = (value: string): string | null => {
  const digits = value.replace(/\D+/g, '')
  return digits.length > 0 ? digits : null
}

const cnaesToArray = (raw: string): readonly string[] | null => {
  const list = raw
    .split(',')
    .map((code) => code.replace(/\D+/g, ''))
    .filter((code) => code.length === 7)
  return list.length > 0 ? list : null
}

const telefoneOf = (ddd: string, tel: string): string | null => {
  const d = digitsOnly(ddd)
  const n = digitsOnly(tel)
  return d !== null && n !== null && n !== '00000000' ? `${d}${n}` : null
}

const emailDomainOf = (raw: string): string | null => {
  const at = raw.indexOf('@')
  return at > 0 && at < raw.length - 1 ? raw.slice(at + 1).toLowerCase() : null
}

const nullIfEmpty = (value: string): string | null => {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

export const toEstabelecimentoValues = (
  fields: readonly string[],
  snapshotMonth: string,
): EstabelecimentoRowValues | null => {
  const cnpjBasico = (fields[0] ?? '').replace(/\D+/g, '')
  if (cnpjBasico.length !== 8) return null

  const tipoLogradouro = nullIfEmpty(fields[13] ?? '')
  const logradouro = nullIfEmpty(fields[14] ?? '')
  const numero = nullIfEmpty(fields[15] ?? '')
  const complemento = nullIfEmpty(fields[16] ?? '')
  const bairro = nullIfEmpty(fields[17] ?? '')
  const cepRaw = digitsOnly(fields[18] ?? '')
  const cep = cepRaw !== null && cepRaw.length === 8 ? cepRaw : null
  const ufRaw = nullIfEmpty(fields[19] ?? '')
  const uf = ufRaw !== null && ufRaw.length === 2 ? ufRaw.toUpperCase() : null
  const municipioCode = digitsOnly(fields[20] ?? '')
  const municipioReceita = municipioCode !== null && municipioCode.length > 0 ? Number(municipioCode) : null
  const paisRaw = digitsOnly(fields[9] ?? '')
  const isExterior =
    nullIfEmpty(fields[8] ?? '') !== null || (paisRaw !== null && paisRaw !== '105' && paisRaw.length > 0)

  const keys =
    !isExterior && (cep !== null || uf !== null) && (logradouro !== null || numero !== null)
      ? addressKeys(
          canonicalizeAddress({
            tipoLogradouro,
            logradouro,
            numero,
            complemento,
            bairro,
            cep,
            uf,
            municipioIbge: null,
            countryCode: 'BR',
          }),
        )
      : null

  const situacao = digitsOnly(fields[5] ?? '')
  const motivo = digitsOnly(fields[7] ?? '')

  return {
    cnpjBasico,
    cnpjOrdem: (fields[1] ?? '').replace(/\D+/g, ''),
    cnpjDv: (fields[2] ?? '').replace(/\D+/g, ''),
    matrizFilial: Number(digitsOnly(fields[3] ?? '') ?? '1'),
    nomeFantasia: nullIfEmpty((fields[4] ?? '').trim()),
    situacaoCadastral: situacao !== null ? Number(situacao) : 0,
    dataSituacao: toIsoDate(fields[6] ?? ''),
    motivoSituacao: motivo !== null && motivo.length > 0 ? Number(motivo) : null,
    dataAbertura: toIsoDate(fields[10] ?? ''),
    cnaePrincipal: digitsOnly(fields[11] ?? ''),
    cnaesSecundarios: cnaesToArray(fields[12] ?? ''),
    tipoLogradouro,
    logradouro,
    numero,
    complemento,
    bairro,
    cep,
    uf,
    municipioReceita,
    municipioIbge: null,
    paisCodigo: paisRaw !== null && paisRaw.length > 0 ? Number(paisRaw) : null,
    cidadeExterior: nullIfEmpty(fields[8] ?? ''),
    telefone: telefoneOf(fields[21] ?? '', fields[22] ?? ''),
    emailDomain: emailDomainOf(fields[27] ?? ''),
    buildingKey: keys === null ? null : keys.buildingKey,
    unitKey: keys === null ? null : keys.unitKey,
    snapshotMonth,
  }
}

/** Projeção para o `insert` do Drizzle: copia o array de CNAEs na fronteira. */
export const toInsertRow = (values: EstabelecimentoRowValues) => ({
  cnpjBasico: values.cnpjBasico,
  cnpjOrdem: values.cnpjOrdem,
  cnpjDv: values.cnpjDv,
  matrizFilial: values.matrizFilial,
  nomeFantasia: values.nomeFantasia,
  situacaoCadastral: values.situacaoCadastral,
  dataSituacao: values.dataSituacao,
  motivoSituacao: values.motivoSituacao,
  dataAbertura: values.dataAbertura,
  cnaePrincipal: values.cnaePrincipal,
  cnaesSecundarios: values.cnaesSecundarios === null ? null : [...values.cnaesSecundarios],
  tipoLogradouro: values.tipoLogradouro,
  logradouro: values.logradouro,
  numero: values.numero,
  complemento: values.complemento,
  bairro: values.bairro,
  cep: values.cep,
  uf: values.uf,
  municipioReceita: values.municipioReceita,
  municipioIbge: values.municipioIbge,
  paisCodigo: values.paisCodigo,
  cidadeExterior: values.cidadeExterior,
  telefone: values.telefone,
  emailDomain: values.emailDomain,
  buildingKey: values.buildingKey,
  unitKey: values.unitKey,
  snapshotMonth: values.snapshotMonth,
})

export type EstabelecimentoInsertRow = ReturnType<typeof toInsertRow>

export interface ReceitaMunicipioRow {
  readonly codigoReceita: number
  readonly nomeNorm: string
}

/** Linha do CSV de municípios (`codigo;nome`); `null` quando vazia ou sem código/nome. */
export const parseMunicipioLine = (line: string): ReceitaMunicipioRow | null => {
  if (line.trim().length === 0) return null
  const [codeRaw, nameRaw] = line.split(';').map(unquote)
  const code = digitsOnly(codeRaw ?? '')
  if (code === null || nameRaw === undefined) return null
  return { codigoReceita: Number(code), nomeNorm: normalizeText(nameRaw) }
}
