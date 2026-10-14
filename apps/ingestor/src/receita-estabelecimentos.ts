import { addressKeys, canonicalizeAddress } from '@comprova/core'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export const COLUMN_MAP = [
  'cnpj_basico',
  'cnpj_ordem',
  'cnpj_dv',
  'matriz_filial',
  'nome_fantasia',
  'situacao_cadastral',
  'data_situacao_cadastral',
  'motivo_situacao_cadastral',
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
  'situacao_especial',
  'data_situacao_especial',
] as const

const parseCsvLine = (line: string, separator: string): readonly string[] => {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? ''
    const next = line[i + 1] ?? ''
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === separator) {
      out.push(field)
      field = ''
    } else {
      field += char
    }
  }
  out.push(field)
  return out
}

const detectSeparator = (header: string): string =>
  (header.match(/;/g)?.length ?? 0) >= (header.match(/,/g)?.length ?? 0) ? ';' : ','

const toRow = (fields: readonly string[]): Record<string, string> =>
  Object.fromEntries(COLUMN_MAP.map((col, i) => [col, (fields[i] ?? '').trim()]))

const nullIfEmpty = (value: string): string | null => (value === '' ? null : value)

const digitsOnly = (value: string | null): string | null =>
  value === null ? null : value.replace(/\D+/g, '') || null

const toInsertValue = (row: Record<string, string>, snapshotMonth: string) => {
  const components = {
    tipoLogradouro: nullIfEmpty(row['tipo_logradouro'] ?? ''),
    logradouro: nullIfEmpty(row['logradouro'] ?? ''),
    numero: nullIfEmpty(row['numero'] ?? ''),
    complemento: nullIfEmpty(row['complemento'] ?? ''),
    bairro: nullIfEmpty(row['bairro'] ?? ''),
    cep: digitsOnly(nullIfEmpty(row['cep'] ?? '')),
    uf: nullIfEmpty(row['uf'] ?? ''),
    municipioIbge: null,
    countryCode: nullIfEmpty(row['pais'] ?? '') === '105' ? 'BR' : 'BR',
  }
  const isExterior =
    nullIfEmpty(row['nome_cidade_exterior'] ?? '') !== null ||
    (nullIfEmpty(row['pais'] ?? '') !== null && row['pais'] !== '105')
  const keys =
    nullIfEmpty(row['cep'] ?? '') === null && nullIfEmpty(row['uf'] ?? '') === null
      ? null
      : addressKeys(canonicalizeAddress(components))
  return {
    cnpjBasico: row['cnpj_basico'] ?? '',
    cnpjOrdem: row['cnpj_ordem'] ?? '',
    cnpjDv: row['cnpj_dv'] ?? '',
    matrizFilial: Number(row['matriz_filial'] ?? '1'),
    nomeFantasia: nullIfEmpty(row['nome_fantasia'] ?? ''),
    situacaoCadastral: Number(row['situacao_cadastral'] ?? '0'),
    dataSituacao: nullIfEmpty(row['data_situacao_cadastral'] ?? ''),
    motivoSituacao:
      nullIfEmpty(row['motivo_situacao_cadastral'] ?? '') === null
        ? null
        : Number(row['motivo_situacao_cadastral']),
    dataAbertura: nullIfEmpty(row['data_inicio_atividade'] ?? ''),
    cnaePrincipal: nullIfEmpty(row['cnae_fiscal_principal'] ?? ''),
    cnaesSecundarios: null,
    tipoLogradouro: nullIfEmpty(row['tipo_logradouro'] ?? ''),
    logradouro: nullIfEmpty(row['logradouro'] ?? ''),
    numero: nullIfEmpty(row['numero'] ?? ''),
    complemento: nullIfEmpty(row['complemento'] ?? ''),
    bairro: nullIfEmpty(row['bairro'] ?? ''),
    cep: digitsOnly(nullIfEmpty(row['cep'] ?? '')),
    uf: nullIfEmpty(row['uf'] ?? ''),
    municipioReceita: nullIfEmpty(row['municipio'] ?? '') === null ? null : Number(row['municipio']),
    municipioIbge: null,
    paisCodigo: nullIfEmpty(row['pais'] ?? '') === null ? null : Number(row['pais']),
    cidadeExterior: nullIfEmpty(row['nome_cidade_exterior'] ?? ''),
    telefone: null,
    emailDomain: null,
    buildingKey: keys === null ? null : keys.buildingKey,
    unitKey: keys === null ? null : keys.unitKey,
    snapshotMonth,
    ...(isExterior ? {} : {}),
  }
}

export interface IngestStats {
  readonly rows: number
  readonly snapshotMonth: string
}

export const ingestReceitaEstabelecimentos = async (
  db: Db,
  csvPath: string,
  limit?: number,
  batchSize = 5_000,
): Promise<IngestStats> => {
  const stream = createReadStream(csvPath, 'utf8')
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const lines = rl[Symbol.asyncIterator]()
  const header = (await lines.next()).value
  if (typeof header !== 'string') {
    throw new Error('arquivo vazio')
  }
  const separator = detectSeparator(header)
  const snapshotMonth = new Date().toISOString().slice(0, 7) + '-01'

  let count = 0
  let batch: ReturnType<typeof toInsertValue>[] = []
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    await db.insert(t.refReceitaEstabelecimento).values(batch).onConflictDoNothing()
    batch = []
  }
  for (let i = 0; ; i++) {
    const next = await lines.next()
    if (next.done === true) break
    if (next.value.trim() === '') continue
    const row = toRow(parseCsvLine(next.value, separator))
    batch.push(toInsertValue(row, snapshotMonth))
    if (batch.length >= batchSize) {
      await flush()
    }
    count++
    if (limit !== undefined && count >= limit) break
  }
  await flush()
  await lines.return?.()
  return { rows: count, snapshotMonth }
}
