import {
  digitsOnly,
  isValidCnpj,
  isValidCpf,
  normalizeCep,
  normalizeLogradouro,
  normalizeNumero,
  normalizeText,
  normalizeUf,
  stripDiacritics,
  type DocumentAnalysisKind,
  type ExtractedAddress,
  type ExtractedHolder,
} from '@comprova/core'

interface LabeledLine {
  readonly label: string
  readonly value: string
  readonly raw: string
}

const labelOf = (value: string): string =>
  stripDiacritics(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

const labeledLines = (text: string): ReadonlyMap<string, LabeledLine> => {
  const map = new Map<string, LabeledLine>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = trimmed.match(/^([^:]{2,40}?)\s*[:-]\s*(.+)$/)
    if (match === null) continue
    const label = labelOf(match[1] ?? '')
    const value = (match[2] ?? '').trim()
    if (label.length === 0 || value.length === 0 || map.has(label)) continue
    map.set(label, { label, value, raw: trimmed })
  }
  return map
}

const pickLabel = (
  labels: ReadonlyMap<string, LabeledLine>,
  names: readonly string[],
): LabeledLine | undefined => {
  for (const name of names) {
    const found = labels.get(name)
    if (found !== undefined) return found
  }
  return undefined
}

const looksLikeNumero = (value: string): boolean => /^(?:\d+[A-Za-z]?|S\/?N)$/i.test(value.trim())

interface AddressParts {
  readonly logradouro: string
  readonly numero: string | null
  readonly complemento: string | null
}

const splitAddress = (value: string): AddressParts => {
  const parts = value
    .split(/\s*,\s*|\s+[-–]\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const first = parts[0] ?? value.trim()
  let numero: string | null = null
  let complemento: string | null = null
  if (parts.length >= 2) {
    const candidate = parts[1] ?? ''
    if (looksLikeNumero(candidate)) {
      numero = candidate
      complemento = parts.length >= 3 ? parts.slice(2).join(', ') : null
    } else {
      complemento = parts.slice(1).join(', ')
    }
  }
  if (numero === null && parts.length === 1) {
    const match = first.match(/^(.*?)[,\s]+(?:N[º°]?\.?\s*)?(\d+[A-Za-z]?)$/)
    if (match !== null) {
      return { logradouro: (match[1] ?? first).trim(), numero: (match[2] ?? '').trim(), complemento }
    }
  }
  return { logradouro: first, numero, complemento }
}

const MAX_FIELD_CHARS = 500
const MAX_RAW_CHARS = 2_000

const cap = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

const ufFromValue = (value: string | null): string | null => {
  if (value === null) return null
  const letters = normalizeText(value).replace(/[^A-Z]/g, '')
  // `normalizeUf` só corta os dois primeiros caracteres; um nome de estado
  // ("São Paulo") viraria "SA". Só aceitamos a sigla de duas letras.
  return letters.length === 2 ? normalizeUf(letters) : null
}

const CEP_RE = /\b(\d{5})-?(\d{3})\b/
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/
const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/

const addressFromText = (text: string, labels: ReadonlyMap<string, LabeledLine>): ExtractedAddress | null => {
  const labeled = pickLabel(labels, ['ENDERECO', 'LOGRADOURO', 'RUA', 'AVENIDA', 'AV'])
  let rawLine = labeled?.raw ?? null
  let parts: AddressParts | null = null
  if (labeled !== undefined) {
    parts = splitAddress(labeled.value)
  } else {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (
        /^(?:RUA|AVENIDA|AV\.?|R\.?|TRAVESSA|TV\.?|ESTRADA|ROD\.?|ALAMEDA|PRACA|PRAÇA|LARGO)\b/i.test(trimmed)
      ) {
        parts = splitAddress(trimmed)
        rawLine = trimmed
        break
      }
    }
  }

  const cepLabel = pickLabel(labels, ['CEP'])
  // Nunca varrer o texto inteiro: o cabeçalho costuma trazer o CEP da
  // distribuidora. Só aceitamos CEP rotulado ou dentro da linha de endereço.
  const cepSource = cepLabel?.value ?? labeled?.value ?? null
  const cepMatch = cepSource === null ? null : cepSource.match(CEP_RE)
  const cep = cepMatch === null ? null : normalizeCep(`${cepMatch[1] ?? ''}${cepMatch[2] ?? ''}`)

  const bairroLabel = pickLabel(labels, ['BAIRRO', 'DISTRITO'])
  const cidadeLabel = pickLabel(labels, ['CIDADE', 'MUNICIPIO', 'MUNICÍPIO'])
  const ufLabel = pickLabel(labels, ['UF', 'ESTADO'])
  let cidade = cidadeLabel?.value ?? null
  let uf = ufFromValue(ufLabel?.value ?? null)
  const cidadeUf = cidade === null ? null : cidade.match(/^(.+?)\s*[/-]\s*([A-Za-z]{2})$/)
  if (cidadeUf !== null) {
    const parsedCidade = cidadeUf[1]
    const parsedUf = cidadeUf[2]
    if (parsedCidade !== undefined) cidade = parsedCidade.trim()
    if (parsedUf !== undefined) uf = ufFromValue(parsedUf)
  }

  const logradouro = parts === null ? null : parts.logradouro
  const numero = parts?.numero ?? null
  const complemento = parts?.complemento ?? null
  const hasAddress = logradouro !== null || cep !== null || (cidade !== null && uf !== null)
  if (!hasAddress) return null

  return {
    logradouro:
      logradouro === null || logradouro.length === 0
        ? null
        : cap(normalizeLogradouro(null, logradouro), MAX_FIELD_CHARS),
    numero: numero === null ? null : cap(normalizeNumero(numero), 32),
    complemento:
      complemento === null || complemento.length === 0
        ? null
        : cap(normalizeText(complemento), MAX_FIELD_CHARS),
    bairro: bairroLabel === undefined ? null : cap(normalizeText(bairroLabel.value), MAX_FIELD_CHARS),
    cidade: cidade === null || cidade.length === 0 ? null : cap(normalizeText(cidade), MAX_FIELD_CHARS),
    uf,
    cep,
    raw: cap(
      [rawLine, bairroLabel?.raw, cidadeLabel?.raw, ufLabel?.raw, cepLabel?.raw]
        .filter((line): line is string => line !== null && line !== undefined && line.length > 0)
        .filter((line, index, lines) => lines.indexOf(line) === index)
        .join(' | '),
      MAX_RAW_CHARS,
    ),
  }
}

interface HolderExtraction {
  readonly holder: ExtractedHolder | null
  readonly taxIdInvalid: boolean
}

const holderFromText = (labels: ReadonlyMap<string, LabeledLine>): HolderExtraction => {
  const nameLabel = pickLabel(labels, ['TITULAR', 'NOMEDOTITULAR', 'NOME', 'CLIENTE', 'RAZAOSOCIAL'])
  const rawName = nameLabel?.value ?? null
  const name =
    rawName === null
      ? null
      : rawName
          .replace(CPF_RE, ' ')
          .replace(CNPJ_RE, ' ')
          .replace(/(?:CPF|CNPJ)\s*[:-]?\s*$/i, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, MAX_FIELD_CHARS) || null

  const cnpjLabel = pickLabel(labels, ['CNPJ'])
  const cpfLabel = pickLabel(labels, ['CPF'])
  // Apenas valores rotulados. O cabeçalho pode trazer o CNPJ da distribuidora
  // (ou um número de 11 dígitos que passa no checksum de CPF), que não é o
  // titular do comprovante.
  const cnpjRaw = cnpjLabel?.value ?? null
  const cpfRaw = cpfLabel?.value ?? null

  if (cnpjRaw !== null && isValidCnpj(cnpjRaw)) {
    return {
      holder: {
        name,
        taxId: digitsOnly(cnpjRaw),
        taxIdType: 'CNPJ',
        raw: cap(name ?? 'CNPJ informado', MAX_RAW_CHARS),
      },
      taxIdInvalid: false,
    }
  }
  if (cpfRaw !== null && isValidCpf(cpfRaw)) {
    return {
      holder: {
        name,
        taxId: digitsOnly(cpfRaw),
        taxIdType: 'CPF',
        raw: cap(name ?? 'CPF informado', MAX_RAW_CHARS),
      },
      taxIdInvalid: false,
    }
  }
  const taxIdInvalid = cnpjRaw !== null || cpfRaw !== null
  if (name === null && !taxIdInvalid) return { holder: null, taxIdInvalid: false }
  return {
    holder: name === null ? null : { name, taxId: null, taxIdType: null, raw: cap(name, MAX_RAW_CHARS) },
    taxIdInvalid,
  }
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

const dateFromText = (value: string): string | null => {
  const full = value.match(/(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (full !== null) return isoDate(Number(full[3]), Number(full[2]), Number(full[1]))
  const month = value.match(/(\d{2})[/-](\d{4})/)
  if (month !== null) return isoDate(Number(month[2]), Number(month[1]), 1)
  const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso !== null) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  return null
}

const kindFromText = (text: string): DocumentAnalysisKind => {
  const normalized = normalizeText(text)
  if (/(ENERGIA|ELETRIC|LUZ|CEMIG|ENEL|CPFL|LIGHT|EQUATORIAL|NEOENERGIA|ENERGISA)/.test(normalized)) {
    return 'electricity_bill'
  }
  if (/(AGUA|SANEAMENTO|SABESP|COPASA|CEDAE|SANEPAR)/.test(normalized)) return 'water_bill'
  if (/(TELEFONE|TELECOM|VIVO|CLARO|TIM|OI|INTERNET|BANDALARGA|NET)/.test(normalized)) {
    return 'telecom_bill'
  }
  if (/(GAS|COMGAS|NATURGY)/.test(normalized)) return 'gas_bill'
  if (/(CONTA|FATURA|COMPROVANTE)/.test(normalized)) return 'utility_bill'
  return 'unknown'
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
  const labels = labeledLines(text)
  const address = addressFromText(text, labels)
  const { holder, taxIdInvalid } = holderFromText(labels)
  const issuedLabel = pickLabel(labels, ['EMISSAO', 'COMPETENCIA', 'REFERENCIA', 'MESREFERENCIA', 'PERIODO'])
  const issuedAt = issuedLabel === undefined ? null : dateFromText(issuedLabel.value)
  return {
    kind: kindFromText(text),
    address,
    holder,
    issuedAt,
    issuedRaw: issuedLabel === undefined ? null : cap(issuedLabel.raw, MAX_RAW_CHARS),
    limitations: taxIdInvalid ? ['TAX_ID_INVALID'] : [],
  }
}
