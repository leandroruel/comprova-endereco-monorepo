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

/**
 * Rótulos que podem fechar um valor na mesma linha. Só cortamos em nomes
 * conhecidos: um `:` solto no meio de um nome/endereço não deve partir o valor.
 */
const KNOWN_LABELS: ReadonlySet<string> = new Set(
  [
    'ENDERECO',
    'LOGRADOURO',
    'NUMERO',
    'COMPLEMENTO',
    'BAIRRO',
    'CIDADE',
    'MUNICIPIO',
    'UF',
    'ESTADO',
    'CEP',
    'TITULAR',
    'NOME DO TITULAR',
    'PAGADOR',
    'NOME',
    'CLIENTE',
    'RAZAO SOCIAL',
    'DATA DE EMISSAO',
    'EMISSAO',
    'COMPETENCIA',
    'CPF',
    'CNPJ',
    'MEDIDOR',
    'VENCIMENTO',
  ].map(labelOf),
)

/** Rótulos que identificam o titular do documento. */
const HOLDER_LABELS: readonly string[] = [
  'TITULAR',
  'NOMEDOTITULAR',
  'PAGADOR',
  'NOME',
  'CLIENTE',
  'RAZAOSOCIAL',
]

/** Janela máxima (em caracteres) antes de um `:` para procurar um rótulo. */
const LABEL_WINDOW_CHARS = 80
/** Linha maior que isto não é um `Rótulo: valor` real. */
const MAX_LABELED_LINE_CHARS = 2_000

/** Índice onde começa o próximo rótulo conhecido dentro de `value`. */
const inlineLabelStart = (value: string): number | null => {
  for (let colon = 0; colon < value.length; colon += 1) {
    if (value[colon] !== ':') continue
    // Só olhamos uma janela fixa antes do `:`: um rótulo real cabe nela, e o
    // custo deixa de crescer com o quadrado do tamanho da linha.
    const windowStart = Math.max(0, colon - LABEL_WINDOW_CHARS)
    const before = value.slice(windowStart, colon)
    const words = before.trimEnd().split(/\s+/)
    if (windowStart > 0) words.shift() // primeira palavra pode estar cortada
    for (let count = Math.min(words.length, 4); count >= 1; count -= 1) {
      const suffix = words.slice(-count).join(' ')
      if (!KNOWN_LABELS.has(labelOf(suffix))) continue
      const start = before.lastIndexOf(suffix)
      if (start >= 0) return windowStart + start
    }
  }
  return null
}

/**
 * Um PDF pode colocar vários rótulos na mesma linha (por exemplo
 * `CEP: 12000-000 MEDIDOR:0013681013` ou
 * `Pagador: Empresa X CNPJ: 00.000.000/0001-00 Vencimento ...`). O valor de
 * cada rótulo termina no início do próximo rótulo conhecido: sem isso, o CEP
 * levava junto o número do medidor e o titular levava junto o CNPJ.
 */
const parseLabeledLine = (line: string): readonly LabeledLine[] => {
  const trimmed = line.trim()
  if (trimmed.length > MAX_LABELED_LINE_CHARS) return []
  const match = trimmed.match(/^([^:]{2,40}):\s*(.+)$/)
  if (match === null) {
    // Linhas longas podem trazer o rótulo no meio, atrás de um prefixo
    // (`NOTA FISCAL Nº ... DATA DE EMISSÃO: 24/04/2025`). Nesse caso só
    // cortamos em um rótulo conhecido, nunca em texto livre.
    const start = inlineLabelStart(trimmed)
    if (start === null || start === 0) return []
    return parseLabeledLine(trimmed.slice(start).replace(/^[\s/,-]+/, ''))
  }
  const label = labelOf(match[1] ?? '')
  if (label.length === 0) return []
  const rest = match[2] ?? ''
  const cut = inlineLabelStart(rest)
  const valuePart = cut === null ? rest : rest.slice(0, cut).trimEnd()
  const value = redactTaxIds(valuePart)
  const segments: LabeledLine[] =
    value.length === 0 ? [] : [{ label, value, raw: redactTaxIds(`${match[1]?.trim() ?? ''}: ${valuePart}`) }]
  if (cut !== null) {
    segments.push(...parseLabeledLine(rest.slice(cut).trim()))
  }
  return segments
}

const labeledLines = (text: string): readonly LabeledLine[] =>
  text.split(/\r?\n/).flatMap((line) => parseLabeledLine(line))

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
  // Alguns layouts (DANF3E) põem o número no fim da linha, sem vírgula:
  // `RUA SANTOS DUMONT 197`. Só separamos quando o último termo é um número
  // isolado; o restante continua sendo o logradouro.
  if (parts.length === 1) {
    const trailing = value.match(/^(.*\S)\s+(\d+[A-Za-z]?|S\/?N)$/i)
    // `Rua 7`/`Avenida 85` são nomes de via, não "logradouro + número": só
    // separamos quando sobra um nome antes do número.
    if (trailing !== null && /\s/.test(trailing[1] ?? '')) {
      return {
        logradouro: trailing[1] ?? value.trim(),
        numero: trailing[2] ?? null,
        complemento: null,
      }
    }
  }
  return { logradouro: value.trim(), numero: null, complemento: null }
}

/**
 * Blocos explicitamente rotulados como endereço. O DANF3E da EDP (e outros
 * layouts de concessionária) não repete `Logradouro:`/`Cidade:` em cada linha:
 * abre um bloco `ENDEREÇO DE ENTREGA:` e lista nome, rua, bairro/cidade-UF e
 * CEP nas linhas seguintes. O bloco é a fonte explícita; texto solto fora dele
 * continua ignorado.
 */
const ADDRESS_SECTION_LABELS: readonly string[] = [
  'ENDERECODEENTREGA',
  'ENDERECODOTITULAR',
  'ENDERECODOCLIENTE',
  'ENDERECODECORRESPONDENCIA',
]

const STREET_PREFIX =
  /^(?:RUA|R\.?|AVENIDA|AV\.?|TRAVESSA|TRAV\.?|ALAMEDA|ALAM\.?|AL\.?|RODOVIA|ROD\.?|ESTRADA|ESTR\.?|EST\.?|PRACA|LARGO|LGO\.?|BECO|BC\.?|VIELA|FAZENDA|FAZ\.?|SITIO|CHACARA|CHAC\.?|VILA|VL\.?|MORRO|MR\.?)\s+/i

const isAddressSectionHeader = (line: string): boolean => {
  const trimmed = line.trim()
  if (!trimmed.endsWith(':')) return false
  const label = labelOf(trimmed.slice(0, -1))
  return ADDRESS_SECTION_LABELS.some((name) => label.endsWith(name))
}

interface CityAndUf {
  readonly neighborhood: string | null
  readonly city: string | null
  readonly uf: string
}

/** `Bairro / Cidade - UF`, `Bairro / Cidade, UF` ou `Cidade - UF`. */
const parseCityAndUf = (text: string): CityAndUf | null => {
  const match = normalizeText(text).match(/^(.+?)\s*[,/-]\s*([A-Z]{2})$/)
  if (match === null) return null
  const head = (match[1] ?? '').trim()
  if (head.length === 0) return null
  const parts = head.split(/\s*\/\s*/)
  return {
    neighborhood: parts.length > 1 ? (parts[0] ?? null) : null,
    city: parts.length > 1 ? (parts[parts.length - 1] ?? null) : head,
    uf: match[2] ?? '',
  }
}

/** `CEP 25085-135`, `CEP: 12000-000`, `CEP 05069-900`. */
const extractCep = (text: string): string | null => {
  const match = text.match(/\bCEP\b\s*:?\s*(\d{5})\s*-?\s*(\d{3})\b/i)
  if (match === null) return null
  return normalizeCep(`${match[1] ?? ''}${match[2] ?? ''}`)
}

/** Rua sem vírgula, com o número no meio e complemento depois. */
const splitStructuralStreet = (value: string): AddressParts => {
  const commaParts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const commaNumber = commaParts[1]
  if (commaNumber !== undefined && /^(?:\d+[A-Za-z]?|S\/?N)$/i.test(commaNumber)) {
    return {
      logradouro: commaParts[0] ?? value.trim(),
      numero: commaNumber,
      complemento: commaParts.length > 2 ? commaParts.slice(2).join(', ') : null,
    }
  }
  const match = value.match(/^(.+?\S)\s+(\d+[A-Za-z]?|S\/?N)(?:\s+(.*\S))?\s*$/i)
  const street = (match?.[1] ?? '').trim()
  // Exige um nome de via antes do número: `RUA 25 DE MARCO` não vira `RUA` + 25.
  if (match === null || street.split(/\s+/).length < 2) {
    return { logradouro: value.trim(), numero: null, complemento: null }
  }
  return {
    logradouro: street,
    numero: match[2] ?? null,
    complemento: match[3]?.trim() ?? null,
  }
}

interface AddressSection {
  readonly name: string | null
  readonly nameRaw: string | null
  readonly street: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly neighborhood: string | null
  readonly city: string | null
  readonly uf: string | null
  readonly cep: string | null
  readonly raw: string
}

const parseAddressSection = (block: readonly string[]): AddressSection | null => {
  const streetIndex = block.findIndex((line) => STREET_PREFIX.test(normalizeText(line)))
  const street = streetIndex === -1 ? null : (block[streetIndex] ?? null)
  const nameLines = streetIndex > 0 ? block.slice(0, streetIndex) : []
  const nameRaw = nameLines.length === 0 ? null : cap(redactTaxIds(nameLines.join(' ')), MAX_RAW_CHARS)
  const name =
    nameRaw === null
      ? null
      : cap(
          nameRaw
            .replace(/\b(?:CPF|CNPJ)\b[\s:=-]*.*$/i, '')
            .replace(/[\s,;:-]+$/, '')
            .trim(),
          MAX_FIELD_CHARS,
        )
  const cepIndex = block.findIndex((line) => extractCep(line) !== null)
  const citySource = block
    .slice(streetIndex === -1 ? 0 : streetIndex + 1, cepIndex === -1 ? block.length : cepIndex)
    .join(' ')
  const city = parseCityAndUf(citySource)
  const cep = extractCep(block.join(' '))
  const parts = street === null ? null : splitAddress(street)

  if (street === null && city == null && cep === null) return null
  return {
    name: name === null || name.length === 0 ? null : name,
    nameRaw,
    street,
    logradouro: parts?.logradouro ?? null,
    numero: parts?.numero ?? null,
    complemento: parts?.complemento ?? null,
    neighborhood: city?.neighborhood ?? null,
    city: city?.city ?? null,
    uf: city?.uf ?? null,
    cep,
    raw: cap(redactTaxIds(block.join(' | ')), MAX_RAW_CHARS),
  }
}

const addressSectionsFromText = (text: string): readonly AddressSection[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const sections: AddressSection[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!isAddressSectionHeader(lines[index] ?? '')) continue
    const block: string[] = []
    for (let cursor = index + 1; cursor < lines.length && block.length < 6; cursor += 1) {
      const candidate = lines[cursor] ?? ''
      if (isAddressSectionHeader(candidate)) break
      block.push(candidate)
      // O CEP fecha o bloco; as linhas seguintes já são dados fiscais/medidor.
      if (/(?:^|\s)CEP\s*:/i.test(candidate)) break
    }
    const section = parseAddressSection(block)
    if (section !== null) sections.push(section)
  }
  return sections
}

const NAME_LINE_RE = /^[A-Z][A-Z\s.'&-]{3,79}$/
const NON_NAME_RE =
  /\b(?:DANF3E|FISCAL|DOCUMENTO|AUXILIAR|GRUPO|SUBGRUPO|RESIDENCIAL|CONTA|NOTA|CHAVE|PROTOCOLO|MEDIDOR|LEITURA|TOTAL)\b/
/**
 * Evidência de que o bloco estrutural é do **destinatário**, não do emitente:
 * CPF (pessoa), medidor, unidade consumidora, conta contrato, instalação ou
 * rótulos de cliente/pagador. Um bloco só com CNPJ/inscrição estadual é
 * tratado como emitente e ignorado.
 */
const RECIPIENT_MARKER_RE =
  /\b(?:CPF|MEDIDOR|UNIDADE\s+CONSUMIDORA|CONTA\s+CONTRATO|INSTALACAO|CLIENTE|DESTINATARIO|PAGADOR)\b/

const looksLikeRecipientName = (line: string): boolean => {
  const normalized = normalizeText(line)
  if (normalized.length < 4 || normalized.length > 80) return false
  if (!NAME_LINE_RE.test(normalized)) return false
  if (/\d/.test(normalized)) return false
  if (normalized.includes('/') || normalized.includes(',') || normalized.includes(':')) return false
  if (normalized.split(/\s+/).length < 2) return false
  if (NON_NAME_RE.test(normalized)) return false
  if (STREET_PREFIX.test(normalized)) return false
  if (parseCityAndUf(normalized) !== null) return false
  return true
}

const cleanRecipientName = (value: string): string | null => {
  const name = cap(
    redactTaxIds(value)
      .replace(/\b(?:CPF|CNPJ)\b[\s:=-]*.*$/i, '')
      .replace(/[\s,;:-]+$/, '')
      .trim(),
    MAX_FIELD_CHARS,
  )
  return name.length === 0 ? null : name
}

/**
 * DANF3E sem cabeçalho textual: o bloco do destinatário vem como
 * `nome` + `rua com número` + `bairro / cidade, UF` + `CEP`. Só aceitamos o
 * bloco quando a sequência inteira existe e termina em CEP — assim evitamos
 * capturar títulos, cabeçalhos de tabela ou linhas soltas.
 *
 * Usado apenas quando não há bloco explicitamente rotulado (ENDEREÇO DE
 * ENTREGA), para que o endereço do emitente não vire ambiguidade.
 */
const recipientBlocksFromText = (text: string): readonly AddressSection[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const blocks: AddressSection[] = []
  for (let index = 0; index < lines.length - 2; index += 1) {
    const nameLine = lines[index] ?? ''
    if (!looksLikeRecipientName(nameLine)) continue
    const street = lines[index + 1] ?? ''
    if (!STREET_PREFIX.test(normalizeText(street))) continue

    const collected: string[] = [street]
    let cepIndex = -1
    for (let cursor = index + 2; cursor < lines.length && collected.length < 5; cursor += 1) {
      collected.push(lines[cursor] ?? '')
      if (extractCep(lines[cursor] ?? '') !== null) {
        cepIndex = collected.length - 1
        break
      }
    }
    if (cepIndex === -1) continue
    const cep = extractCep(collected[cepIndex] ?? '')
    if (cep === null) continue
    const city = parseCityAndUf(collected.slice(1, cepIndex).join(' '))
    if (city === null) continue
    const parts = splitStructuralStreet(street)
    if (parts.logradouro.length < 4) continue
    // Sem marcador de destinatário nas linhas do bloco ou logo depois, é mais
    // provável ser o emitente (CNPJ/inscrição estadual). Não extraímos nada.
    const afterStart = index + 1 + collected.length
    const evidence = normalizeText([...collected, ...lines.slice(afterStart, afterStart + 3)].join(' '))
    if (!RECIPIENT_MARKER_RE.test(evidence)) continue

    blocks.push({
      name: cleanRecipientName(nameLine),
      nameRaw: cap(redactTaxIds(nameLine), MAX_RAW_CHARS),
      street,
      logradouro: parts.logradouro,
      numero: parts.numero,
      complemento: parts.complemento,
      neighborhood: city.neighborhood,
      city: city.city,
      uf: city.uf,
      cep,
      raw: cap(redactTaxIds([nameLine, ...collected].join(' | ')), MAX_RAW_CHARS),
    })
  }
  return blocks
}

/** Um valor só é usado quando todas as ocorrências explícitas concordam. */
const pickSectionField = (
  sections: readonly AddressSection[],
  pick: (section: AddressSection) => string | null,
  normalize: (value: string) => string = normalizeText,
): string | null => {
  const values = sections.map(pick).filter((value): value is string => value !== null && value.length > 0)
  const first = values[0]
  if (first === undefined) return null
  return values.every((value) => normalize(value) === normalize(first)) ? first : null
}

/**
 * Rótulo de linha e bloco de endereço são fontes explícitas distintas. Quando
 * ambos existem e discordam, o campo fica `null` (ambíguo) em vez de escolher
 * arbitrariamente — a mesma regra de `pickUnique`.
 */
const resolveField = (
  labeled: string | null,
  section: string | null,
  normalize: (value: string) => string = normalizeText,
): string | null => {
  if (labeled === null || labeled.length === 0) return section
  if (section === null || section.length === 0) return labeled
  return normalize(labeled) === normalize(section) ? labeled : null
}

/**
 * O mesmo logradouro pode aparecer como `Rua X` em um rótulo e `Rua X, 123` no
 * bloco. Comparamos o logradouro (e o número, quando ambos têm); divergência em
 * qualquer um dos dois é ambiguidade. Se só uma fonte tem número, usamos a mais
 * completa em vez de descartar o número.
 */
const resolveStreet = (labeled: string | null, section: string | null): string | null => {
  if (labeled === null || labeled.length === 0) return section
  if (section === null || section.length === 0) return labeled
  const labeledParts = splitAddress(labeled)
  const sectionParts = splitAddress(section)
  if (normalizeText(labeledParts.logradouro) !== normalizeText(sectionParts.logradouro)) return null
  if (
    labeledParts.numero !== null &&
    sectionParts.numero !== null &&
    normalizeNumero(labeledParts.numero) !== normalizeNumero(sectionParts.numero)
  ) {
    return null
  }
  return labeledParts.numero !== null ? labeled : section
}

const addressFromLines = (lines: readonly LabeledLine[], text: string): ExtractedAddress | null => {
  // Bloco rotulado tem prioridade. O bloco estrutural (DANF3E sem cabeçalho)
  // só preenche os campos que não têm rótulo próprio: não sobrescreve nem
  // anula valores rotulados, e não confunde emitente com destinatário.
  const explicitSections = addressSectionsFromText(text)
  let structuralSections = explicitSections.length > 0 ? [] : recipientBlocksFromText(text)
  // Se há titular rotulado, o bloco estrutural só é usado quando é a mesma
  // pessoa/empresa; um bloco de outro nome (ex.: emitente) é descartado por
  // inteiro, evitando misturar endereços de titulares diferentes.
  const labeledHolder = pickUnique(lines, HOLDER_LABELS)
  if (labeledHolder !== null && structuralSections.length > 0) {
    const holderName = normalizeText(labeledHolder.value)
    const agrees = structuralSections.some(
      (section) => section.name !== null && normalizeText(section.name) === holderName,
    )
    if (!agrees) structuralSections = []
  }
  const labeledLabels = new Set(lines.map((line) => line.label))
  const sectionsFor = (names: readonly string[]): readonly AddressSection[] => {
    if (explicitSections.length > 0) return explicitSections
    return names.some((name) => labeledLabels.has(labelOf(name))) ? [] : structuralSections
  }
  const auditSection = explicitSections[0] ?? structuralSections[0]

  const streetLine = pickUnique(lines, ['ENDERECO', 'LOGRADOURO'])
  const numberLine = pickUnique(lines, ['NUMERO'])
  const complementLine = pickUnique(lines, ['COMPLEMENTO'])
  const neighborhoodLine = pickUnique(lines, ['BAIRRO'])
  const cityLine = pickUnique(lines, ['CIDADE', 'MUNICIPIO'])
  const stateLine = pickUnique(lines, ['UF', 'ESTADO'])
  const cepLine = pickUnique(lines, ['CEP'])

  const labeledStreet = streetLine?.value ?? null
  const sectionStreet = pickSectionField(sectionsFor(['ENDERECO', 'LOGRADOURO']), (s) => s.street)
  const streetValue = resolveStreet(labeledStreet, sectionStreet)
  const usingSectionStreet = streetValue !== null && sectionStreet !== null && streetValue === sectionStreet
  const parts = streetValue === null ? null : splitAddress(streetValue)
  const logradouro = usingSectionStreet
    ? pickSectionField(sectionsFor(['ENDERECO', 'LOGRADOURO']), (s) => s.logradouro)
    : (parts?.logradouro ?? null)
  const embeddedNumber = usingSectionStreet
    ? pickSectionField(sectionsFor(['NUMERO']), (s) => s.numero)
    : (parts?.numero ?? null)
  const labeledNumber = numberLine?.value ?? null
  const numero =
    embeddedNumber === null
      ? labeledNumber
      : labeledNumber === null
        ? embeddedNumber
        : normalizeNumero(embeddedNumber) === normalizeNumero(labeledNumber)
          ? labeledNumber
          : null
  const complemento =
    complementLine?.value ??
    (usingSectionStreet ? pickSectionField(sectionsFor(['COMPLEMENTO']), (s) => s.complemento) : null) ??
    parts?.complemento ??
    null

  const cepValue = resolveField(
    cepLine?.value ?? null,
    pickSectionField(
      sectionsFor(['CEP']),
      (s) => s.cep,
      (value) => value.replace(/\D+/g, ''),
    ),
    (value) => value.replace(/\D+/g, ''),
  )
  const cepDigits = (cepValue ?? '').replace(/\D+/g, '')
  const cep = cepDigits.length === 8 ? normalizeCep(cepDigits) : null
  const ufRaw =
    resolveField(
      stateLine?.value.trim() ?? null,
      pickSectionField(sectionsFor(['UF', 'ESTADO']), (s) => s.uf),
    ) ?? ''
  const uf = /^[A-Za-z]{2}$/.test(ufRaw) ? normalizeUf(ufRaw) : null
  const cidadeValue = resolveField(
    cityLine?.value ?? null,
    pickSectionField(sectionsFor(['CIDADE', 'MUNICIPIO']), (s) => s.city),
  )
  const cidade = cidadeValue === null ? null : cap(normalizeText(cidadeValue), MAX_FIELD_CHARS)
  const bairroValue = resolveField(
    neighborhoodLine?.value ?? null,
    pickSectionField(sectionsFor(['BAIRRO']), (s) => s.neighborhood),
  )

  if (logradouro === null && cep === null && bairroValue === null && (cidade === null || uf === null)) {
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
    bairro:
      bairroValue === null || bairroValue.length === 0
        ? null
        : cap(normalizeText(bairroValue), MAX_FIELD_CHARS),
    cidade,
    uf,
    cep,
    raw: cap(
      [
        streetLine?.raw,
        numberLine?.raw,
        complementLine?.raw,
        neighborhoodLine?.raw,
        cityLine?.raw,
        stateLine?.raw,
        cepLine?.raw,
        // O bloco é a evidência de auditoria do que veio de uma seção explícita
        // ou estrutural; repetições idênticas não precisam ser concatenadas.
        auditSection?.raw,
      ]
        .filter((line): line is string => line !== null && line !== undefined)
        .filter((line, index, all) => all.indexOf(line) === index)
        .join(' | '),
      MAX_RAW_CHARS,
    ),
  }
}

const holderFromLines = (lines: readonly LabeledLine[], text: string): ExtractedHolder | null => {
  const nameLine = pickUnique(lines, HOLDER_LABELS)
  const explicitSections = addressSectionsFromText(text)
  // Rótulo de titular sempre vence; o bloco estrutural só é consultado quando
  // não há nenhum rótulo de titular (senão um bloco de emitente poderia anular
  // ou substituir o titular rotulado).
  const sections =
    explicitSections.length > 0 ? explicitSections : nameLine !== null ? [] : recipientBlocksFromText(text)
  const sectionName = pickSectionField(sections, (s) => s.name)
  const rawValue = resolveField(nameLine?.value ?? null, sectionName)
  if (rawValue === null) return null
  // Remove um identificador fiscal que tenha vindo na mesma linha. O F1.2 não
  // persiste CPF/CNPJ; essa decisão fica para a verificação (F1.3/F2).
  const name = cap(
    rawValue
      .replace(/\b(?:CPF|CNPJ)\b[\s:=-]*.*$/i, '')
      .replace(/[\s,;:-]+$/, '')
      .trim(),
    MAX_FIELD_CHARS,
  )
  if (name.length === 0) return null
  const raw =
    nameLine?.raw ?? sections.find((section) => section.name === sectionName)?.nameRaw ?? sectionName ?? name
  return { name, raw: cap(raw, MAX_RAW_CHARS) }
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
    address: addressFromLines(lines, text),
    holder: holderFromLines(lines, text),
    issuedAt: issued.issuedAt,
    issuedRaw: issued.issuedRaw,
    limitations: [],
  }
}
