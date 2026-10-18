import { addressKeys, canonicalizeAddress, normalizeText } from '@comprova/core'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

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

const unquote = (field: string): string => field.replace(/^"|"$/g, '')

const parseLine = (line: string): readonly string[] => {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? ''
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ';' && !inQuotes) {
      fields.push(unquote(current))
      current = ''
    } else {
      current += char
    }
  }
  fields.push(unquote(current))
  return fields
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

export interface IngestStats {
  readonly rows: number
  readonly snapshotMonth: string
  readonly elapsedMs: number
}

export const ingestReceitaEstabelecimentos = async (
  db: Db,
  csvPath: string,
  snapshotMonth: string,
  options: { readonly limit?: number; readonly batchSize?: number } = {},
): Promise<IngestStats> => {
  const batchSize = options.batchSize ?? 2_000
  const started = Date.now()

  const stream = createReadStream(csvPath, { encoding: 'latin1' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const lines = rl[Symbol.asyncIterator]()

  let count = 0
  let batch: ReturnType<typeof toInsertRow>[] = []
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const { upsertEstabelecimentosWithHistory } = await import('./estabelecimento-upsert.js')
    await upsertEstabelecimentosWithHistory(
      db,
      batch as unknown as readonly Record<string, unknown>[],
      snapshotMonth,
    )
    batch = []
  }

  for (;;) {
    const next = await lines.next()
    if (next.done === true) break
    const line = next.value
    if (line.trim().length === 0) continue
    const values = toEstabelecimentoValues(parseLine(line), snapshotMonth)
    if (values !== null) {
      batch.push(toInsertRow(values))
      if (batch.length >= batchSize) {
        await flush()
      }
      count++
      if (options.limit !== undefined && count >= options.limit) break
    }
  }
  await flush()
  await lines.return?.()
  return { rows: count, snapshotMonth, elapsedMs: Date.now() - started }
}

export const ingestReceitaMunicipios = async (db: Db, csvPath: string): Promise<number> => {
  const stream = createReadStream(csvPath, { encoding: 'latin1' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const rows: { codigoReceita: number; nomeNorm: string }[] = []
  for await (const line of rl) {
    if (line.trim().length === 0) continue
    const [codeRaw, nameRaw] = line.split(';').map(unquote)
    const code = digitsOnly(codeRaw ?? '')
    if (code === null || nameRaw === undefined) continue
    rows.push({
      codigoReceita: Number(code),
      nomeNorm: normalizeText(nameRaw),
    })
  }
  if (rows.length > 0) {
    await db
      .insert(t.refReceitaMunicipio)
      .values(
        rows.map((r) => ({
          codigoReceita: r.codigoReceita,
          nomeNorm: r.nomeNorm,
        })),
      )
      .onConflictDoNothing()
  }
  return rows.length
}
