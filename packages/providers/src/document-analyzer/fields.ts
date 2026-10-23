import {
  normalizeCep,
  normalizeLogradouro,
  normalizeNumero,
  normalizeText,
  normalizeUf,
  type DocumentAnalysisKind,
  type ExtractedAddress,
  type ExtractedHolder,
} from '@comprova/core'

/**
 * Extração conservadora de campos **explicitamente rotulados**.
 *
 * Esta camada não tenta interpretar o documento inteiro nem inferir campos a
 * partir de texto livre. Quando um rótulo não existe, é ambíguo ou inválido, o
 * campo fica `null` e o chamador produz `not_extracted`. A semântica
 * (`matches`/`differs`, validade, vínculo) pertence ao verificador, não aqui.
 */

interface LabeledLine {
  readonly label: string
  readonly value: string
  readonly raw: string
}

const MAX_FIELD_CHARS = 300
const MAX_RAW_CHARS = 1_000

const cap = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

/**
 * O F1.2 não persiste CPF/CNPJ. A redação acontece antes de qualquer campo
 * normalizado ou `raw`, inclusive quando o identificador está na mesma linha do
 * titular/endereço. Não validamos checksum: só removemos o padrão do texto.
 */
const TAX_ID_PATTERNS: readonly RegExp[] = [
  /\b(?:CPF|CNPJ)\b[\s:=-]*\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/gi,
  /\b(?:CPF|CNPJ)\b[\s:=-]*\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/gi,
  /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
  /\b\d{14}\b/g,
  /\b\d{11}\b/g,
]

const redactTaxIds = (value: string): string => {
  let result = value
  for (const pattern of TAX_ID_PATTERNS) result = result.replace(pattern, ' ')
  return result
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:-])/g, '$1')
    .trim()
}

const labelOf = (value: string): string => normalizeText(value).replace(/[^A-Z0-9]/g, '')

/** Aceita apenas `Rótulo: valor`; hífens e texto livre ficam de fora. */
const parseLabeledLine = (line: string): LabeledLine | null => {
  const trimmed = line.trim()
  const match = trimmed.match(/^([^:]{2,40}):\s*(.+)$/)
  if (match === null) return null
  const label = labelOf(match[1] ?? '')
  const value = redactTaxIds(match[2] ?? '')
  if (label.length === 0 || value.length === 0) return null
  return { label, value, raw: redactTaxIds(trimmed) }
}

const labeledLines = (text: string): readonly LabeledLine[] =>
  text
    .split(/\r?\n/)
    .map(parseLabeledLine)
    .filter((line): line is LabeledLine => line !== null)

/**
 * Retorna o valor apenas quando o rótulo é inequívoco. Rótulos repetidos com
 * valores diferentes (por exemplo, endereço da distribuidora no cabeçalho e do
 * cliente no corpo) são tratados como ambíguos e não produzem extração.
 */
const pickUnique = (lines: readonly LabeledLine[], names: readonly string[]): LabeledLine | null => {
  const wanted = new Set(names.map(labelOf))
  const matches = lines.filter((line) => wanted.has(line.label))
  const first = matches[0]
  if (first === undefined) return null
  return matches.every((line) => line.value === first.value) ? first : null
}

interface AddressParts {
  readonly logradouro: string
  readonly numero: string | null
  readonly complemento: string | null
}

const splitAddress = (value: string): AddressParts => {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const logradouro = parts[0] ?? value.trim()
  const candidate = parts[1]
  if (candidate !== undefined && /^(?:\d+[A-Za-z]?|S\/?N)$/i.test(candidate)) {
    return {
      logradouro,
      numero: candidate,
      complemento: parts.length > 2 ? parts.slice(2).join(', ') : null,
    }
  }
  return { logradouro: value.trim(), numero: null, complemento: null }
}

const addressFromLines = (lines: readonly LabeledLine[]): ExtractedAddress | null => {
  const street = pickUnique(lines, ['ENDERECO', 'LOGRADOURO'])
  const number = pickUnique(lines, ['NUMERO'])
  const complement = pickUnique(lines, ['COMPLEMENTO'])
  const neighborhood = pickUnique(lines, ['BAIRRO'])
  const city = pickUnique(lines, ['CIDADE', 'MUNICIPIO'])
  const state = pickUnique(lines, ['UF', 'ESTADO'])
  const cepLine = pickUnique(lines, ['CEP'])

  const parts = street === null ? null : splitAddress(street.value)
  const logradouro = parts?.logradouro ?? null
  const numero = number?.value ?? parts?.numero ?? null
  const complemento = complement?.value ?? parts?.complemento ?? null

  const cepDigits = (cepLine?.value ?? '').replace(/\D+/g, '')
  const cep = cepDigits.length === 8 ? normalizeCep(cepDigits) : null
  const ufRaw = state?.value.trim() ?? ''
  const uf = /^[A-Za-z]{2}$/.test(ufRaw) ? normalizeUf(ufRaw) : null
  const cidade = city === null ? null : cap(normalizeText(city.value), MAX_FIELD_CHARS)

  if (logradouro === null && cep === null && neighborhood === null && (cidade === null || uf === null)) {
    return null
  }

  return {
    logradouro:
      logradouro === null || logradouro.length === 0
        ? null
        : cap(normalizeLogradouro(null, logradouro), MAX_FIELD_CHARS),
    numero: numero === null || numero.length === 0 ? null : cap(normalizeNumero(numero), 32),
    complemento:
      complemento === null || complemento.length === 0
        ? null
        : cap(normalizeText(complemento), MAX_FIELD_CHARS),
    bairro: neighborhood === null ? null : cap(normalizeText(neighborhood.value), MAX_FIELD_CHARS),
    cidade,
    uf,
    cep,
    raw: cap(
      [street?.raw, number?.raw, complement?.raw, neighborhood?.raw, city?.raw, state?.raw, cepLine?.raw]
        .filter((line): line is string => line !== undefined)
        .filter((line, index, all) => all.indexOf(line) === index)
        .join(' | '),
      MAX_RAW_CHARS,
    ),
  }
}

const holderFromLines = (lines: readonly LabeledLine[]): ExtractedHolder | null => {
  const nameLine = pickUnique(lines, ['TITULAR', 'NOMEDOTITULAR', 'NOME', 'CLIENTE', 'RAZAOSOCIAL'])
  if (nameLine === null) return null
  // Remove um identificador fiscal que tenha vindo na mesma linha. O F1.2 não
  // persiste CPF/CNPJ; essa decisão fica para a verificação (F1.3/F2).
  const name = cap(
    nameLine.value
      .replace(/\b(?:CPF|CNPJ)\b[\s:=-]*.*$/i, '')
      .replace(/[\s,;:-]+$/, '')
      .trim(),
    MAX_FIELD_CHARS,
  )
  if (name.length === 0) return null
  return { name, raw: cap(nameLine.raw, MAX_RAW_CHARS) }
}

const isoDate = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const dateFromValue = (value: string): string | null => {
  const brazilian = value.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/)
  if (brazilian !== null) return isoDate(Number(brazilian[3]), Number(brazilian[2]), Number(brazilian[1]))
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso !== null) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  return null
}

const issuedFromLines = (
  lines: readonly LabeledLine[],
): { readonly issuedAt: string | null; readonly issuedRaw: string | null } => {
  // `issuedAt` é a data de emissão quando ela existe; `Competência` é apenas
  // uma observação alternativa quando não há emissão. Nenhuma das duas define
  // validade do documento.
  const emission = pickUnique(lines, ['EMISSAO', 'DATAEMISSAO', 'DATADEEMISSAO'])
  const reference = pickUnique(lines, ['COMPETENCIA'])
  const line = emission ?? reference
  if (line === null) return { issuedAt: null, issuedRaw: null }
  return { issuedAt: dateFromValue(line.value), issuedRaw: cap(line.raw, MAX_RAW_CHARS) }
}

export interface PdfFields {
  readonly kind: DocumentAnalysisKind
  readonly address: ExtractedAddress | null
  readonly holder: ExtractedHolder | null
  readonly issuedAt: string | null
  readonly issuedRaw: string | null
  readonly limitations: readonly string[]
}

export const fieldsFromPdfText = (text: string): PdfFields => {
  const lines = labeledLines(text)
  const issued = issuedFromLines(lines)
  return {
    // O analisador não classifica concessionária/documento por lista de nomes.
    // Adaptadores de fonte fiscal poderão preencher `kind` com dado confiável.
    kind: 'unknown',
    address: addressFromLines(lines),
    holder: holderFromLines(lines),
    issuedAt: issued.issuedAt,
    issuedRaw: issued.issuedRaw,
    limitations: [],
  }
}
