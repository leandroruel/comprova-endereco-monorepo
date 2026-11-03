/**
 * F1.2 — extração estruturada de tabelas e blocos do Marker.
 *
 * O Marker retorna páginas com elementos tipados (incluindo `table`). Este
 * módulo converte células de tabela em candidatos `rótulo: valor` e aplica a
 * mesma regra de ambiguidade do extrator baseado em texto (`fields.ts`):
 * rótulos repetidos com valores diferentes → ausência de extração.
 *
 * Uma conta de energia pode trazer dados da distribuidora e do consumidor na
 * mesma página. Por isso os rótulos são classificados pelo papel que
 * representam: só os explícitos de titular/consumidor produzem titular, e
 * endereço genérico (`ENDEREÇO`, `CIDADE`, `CEP`, ...) só é usado quando há
 * evidência contextual de que pertence ao consumidor. Sem essa evidência, o
 * campo fica ausente.
 *
 * Não infere campos, não escolhe arbitrariamente entre múltiplos valores e não
 * altera a semântica do `DocumentAnalysisResult`.
 */

import { normalizeText, type ExtractedAddress, type ExtractedHolder } from '@comprova/core'
import type { DocumentIntelligenceTable } from '@comprova/contracts'
import { splitAddress } from './fields.js'

/**
 * Candidato extraído de uma célula de tabela. `page` é o número da página
 * (1-based) quando disponível. `source` identifica a tabela de origem para
 * evitar combinar campos de fontes distintas.
 */
export interface TableCandidate {
  readonly label: string
  readonly value: string
  readonly raw: string
  readonly page: number
  readonly source: string
}

const labelOf = (value: string): string => normalizeText(value).replace(/[^A-Z0-9]/g, '')

/**
 * Rótulos explícitos do titular/consumidor. São a única fonte aceitável para o
 * campo `holder`: `NOME`, `EMPRESA`, `FORNECEDOR` e `RAZÃO SOCIAL` são
 * genéricos e podem identificar a distribuidora.
 */
const HOLDER_LABELS: ReadonlySet<string> = new Set(
  [
    'TITULAR',
    'NOMEDOTITULAR',
    'CLIENTE',
    'NOMEDOCLIENTE',
    'CONSUMIDOR',
    'NOMEDOCONSUMIDOR',
    'PAGADOR',
    'NOMEDOPAGADOR',
    'DESTINATARIO',
    'NOMEDODESTINATARIO',
  ].map(labelOf),
)

/**
 * Rótulos explícitos de endereço de fornecimento/instalação. Quando aparecem,
 * são a evidência de que o endereço pertence ao consumidor.
 */
const SUPPLY_ADDRESS_LABELS: ReadonlySet<string> = new Set(
  [
    'ENDERECODEFORNECIMENTO',
    'ENDERECODEINSTALACAO',
    'ENDERECODOCONSUMIDOR',
    'ENDERECODOCLIENTE',
    'ENDERECODAUNIDADE',
    'ENDERECODAUC',
    'ENDERECODOIMOVEL',
    'ENDERECODEENTREGA',
    'ENDERECODOLOCAL',
    'LOCALDASINSTALACAO',
    'LOCALDAINSTALACAO',
    'ENDERECOINSTALACAO',
  ].map(labelOf),
)

/** Campos de endereço sem semântica própria: exigem contexto do consumidor. */
const GENERIC_ADDRESS_LABELS: ReadonlySet<string> = new Set(
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
  ].map(labelOf),
)

/**
 * Rótulos que apontam para a distribuidora/emitente. Quando um deles aparece
 * na mesma tabela, os campos genéricos de endereço não podem ser atribuídos ao
 * consumidor (a tabela mistura os dois papéis).
 */
const DISTRIBUTOR_LABELS: ReadonlySet<string> = new Set(
  [
    'CONCESSIONARIA',
    'DISTRIBUIDORA',
    'EMPRESA',
    'FORNECEDOR',
    'RAZAOSOCIAL',
    'NOMEDAEMPRESA',
    'NOMEEMPRESARIAL',
  ].map(labelOf),
)

/** Unidade/instalação: identificam a UC, não o endereço nem o titular. */
const INSTALLATION_LABELS: ReadonlySet<string> = new Set(
  ['UNIDADECONSUMIDORA', 'INSTALACAO', 'NUMEROINSTALACAO', 'NUMEROUNIDADE', 'CODIGOUNIDADE'].map(labelOf),
)

/**
 * Rótulos reconhecidos em tabelas (para detectar a linha de cabeçalho). O
 * significado de cada grupo é aplicado depois, em `addressFromTableCandidates`
 * e `holderFromTableCandidates`.
 */
const TABLE_LABELS: ReadonlySet<string> = new Set([
  ...HOLDER_LABELS,
  ...SUPPLY_ADDRESS_LABELS,
  ...GENERIC_ADDRESS_LABELS,
  ...DISTRIBUTOR_LABELS,
  ...INSTALLATION_LABELS,
  // Medidor
  ...['MEDIDOR', 'NUMEROMEDIDOR'].map(labelOf),
])

const isBlank = (value: string): boolean => value.trim().length === 0

/**
 * Extrai candidatos `rótulo: valor` das tabelas do Marker.
 *
 * Cada linha de dados é percorrida coluna a coluna: quando o cabeçalho da
 * coluna é um rótulo conhecido e a célula tem valor, cria-se um candidato.
 * Linhas sem cabeçalho explícito usam a primeira linha como cabeçalho.
 */
export const extractTableCandidates = (
  tables: readonly DocumentIntelligenceTable[],
): readonly TableCandidate[] => {
  const candidates: TableCandidate[] = []

  for (const [ti, table] of tables.entries()) {
    const headers = table.headers
    let effectiveHeaders: readonly string[]
    let firstDataRowIndex: number

    if (headers.length > 0) {
      // Cabeçalhos explícitos: usam-nos como rótulos de coluna; todas as
      // linhas são dados.
      effectiveHeaders = headers
      firstDataRowIndex = 0
    } else if (
      table.rows.length > 0 &&
      table.rows[0]?.every((cell) => TABLE_LABELS.has(labelOf(cell))) === true
    ) {
      // Sem cabeçalhos explícitos: só usa a primeira linha como cabeçalho se
      // todas as suas células forem rótulos conhecidos. Senão, não infere
      // colunas nem produz candidatos desta tabela.
      effectiveHeaders = table.rows[0] ?? []
      firstDataRowIndex = 1
    } else {
      continue
    }

    for (let ri = firstDataRowIndex; ri < table.rows.length; ri += 1) {
      const row = table.rows[ri]
      if (row === undefined) continue
      // Fonte = tabela de origem. Candidatos de tabelas distintas nunca se
      // mesclam; dentro de uma mesma tabela a regra de ambiguidade (rótulo com
      // valores divergentes → ausência) continua valendo.
      const source = `t${ti}`
      for (let i = 0; i < effectiveHeaders.length; i += 1) {
        const header = effectiveHeaders[i] ?? ''
        const value = row[i] ?? ''
        if (isBlank(header) || isBlank(value)) continue

        const label = labelOf(header)
        if (!TABLE_LABELS.has(label)) continue

        candidates.push({
          label,
          value: value.trim(),
          raw: `${header.trim()}: ${value.trim()}`,
          page: 0, // O schema atual do DI não expõe página por tabela
          source,
        })
      }
    }
  }

  return candidates
}

/**
 * Retorna o valor apenas quando o rótulo é inequívoco entre os candidatos.
 * Rótulos repetidos com valores diferentes (ex.: endereço da distribuidora no
 * cabeçalho e do cliente no corpo) são tratados como ambíguos → `null`.
 */
export const pickUniqueCandidate = (
  candidates: readonly TableCandidate[],
  labels: readonly string[],
): { readonly value: string; readonly raw: string } | null => {
  const wanted = new Set(labels.map(labelOf))
  const matches = candidates.filter((c) => wanted.has(c.label))
  if (matches.length === 0) return null
  const first = matches[0]
  if (first === undefined) return null
  return matches.every((m) => m.value === first.value) ? { value: first.value, raw: first.raw } : null
}

type GroupAddress =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'value'; readonly value: ExtractedAddress }

const canonicalField = (value: string | null): string => (value === null ? '\u0000' : normalizeText(value))

const addressKey = (address: ExtractedAddress): string =>
  [
    canonicalField(address.logradouro),
    canonicalField(address.numero),
    canonicalField(address.complemento),
    canonicalField(address.bairro),
    canonicalField(address.cidade),
    canonicalField(address.uf),
    canonicalField(address.cep === null ? null : address.cep.replace(/\D+/g, '')),
  ].join('\u0001')

/**
 * Endereço explícito: a célula rotulada como endereço de fornecimento contém o
 * endereço inteiro (rua + número), então é interpretada como uma unidade. Os
 * campos genéricos da mesma tabela não entram: podem ser da distribuidora.
 */
const explicitAddress = (candidate: { readonly value: string; readonly raw: string }): GroupAddress => {
  const parts = splitAddress(candidate.value)
  if (isBlank(parts.logradouro)) return { kind: 'ambiguous' }
  return {
    kind: 'value',
    value: {
      logradouro: parts.logradouro,
      numero: parts.numero,
      complemento: parts.complemento,
      bairro: null,
      cidade: null,
      uf: null,
      cep: null,
      raw: candidate.raw,
    },
  }
}

/**
 * Endereço genérico: só é atribuído ao consumidor quando a tabela tem contexto
 * de consumidor (titular/cliente/consumidor) e não tem contexto de
 * distribuidora. Caso contrário, não há evidência de que o endereço não é o da
 * concessionária.
 */
const genericAddress = (group: readonly TableCandidate[]): GroupAddress => {
  const street = pickUniqueCandidate(group, ['LOGRADOURO', 'ENDERECO'])
  // Logradouro com valores divergentes é ambiguidade, não ausência parcial.
  if (
    street === null &&
    group.some((candidate) => candidate.label === 'LOGRADOURO' || candidate.label === 'ENDERECO')
  ) {
    return { kind: 'ambiguous' }
  }
  const number = pickUniqueCandidate(group, ['NUMERO'])
  const complement = pickUniqueCandidate(group, ['COMPLEMENTO'])
  const neighborhood = pickUniqueCandidate(group, ['BAIRRO'])
  const city = pickUniqueCandidate(group, ['CIDADE', 'MUNICIPIO'])
  const uf = pickUniqueCandidate(group, ['UF', 'ESTADO'])
  const cep = pickUniqueCandidate(group, ['CEP'])

  const hasAny =
    street !== null ||
    number !== null ||
    complement !== null ||
    neighborhood !== null ||
    city !== null ||
    uf !== null ||
    cep !== null
  if (!hasAny) return { kind: 'none' }

  // Endereço parcial: sem logradouro, CEP ou bairro, cidade e UF são exigidas juntas.
  if (street === null && cep === null && neighborhood === null && (city === null || uf === null)) {
    return { kind: 'none' }
  }

  return {
    kind: 'value',
    value: {
      logradouro: street?.value ?? null,
      numero: number?.value ?? null,
      complemento: complement?.value ?? null,
      bairro: neighborhood?.value ?? null,
      cidade: city?.value ?? null,
      uf: uf?.value?.toUpperCase() ?? null,
      cep: cep?.value ?? null,
      raw: [street, number, complement, neighborhood, city, uf, cep]
        .filter((candidate) => candidate !== null)
        .map((candidate) => candidate!.raw)
        .join('; '),
    },
  }
}

const addressFromGroup = (group: readonly TableCandidate[]): GroupAddress => {
  const hasExplicitSupply = group.some((candidate) => SUPPLY_ADDRESS_LABELS.has(candidate.label))
  if (hasExplicitSupply) {
    // Rótulos explícitos podem ter mais de um tipo (fornecimento/entrega); só
    // vale quando todos concordam no valor.
    const supply = pickUniqueCandidate(group, [...SUPPLY_ADDRESS_LABELS])
    return supply === null ? { kind: 'ambiguous' } : explicitAddress(supply)
  }

  const hasConsumerContext = group.some((candidate) => HOLDER_LABELS.has(candidate.label))
  const hasDistributorContext = group.some((candidate) => DISTRIBUTOR_LABELS.has(candidate.label))
  if (!hasConsumerContext || hasDistributorContext) return { kind: 'none' }

  return genericAddress(group)
}

/**
 * Extrai endereço de fornecimento a partir de candidatos de tabela.
 * Retorna `null` quando não há evidência suficiente ou há ambiguidade.
 *
 * Regras:
 * - Rótulo explícito de fornecimento/instalação vence; os campos genéricos da
 *   mesma tabela não são misturados a ele.
 * - Sem rótulo explícito, o endereço genérico exige contexto de consumidor e a
 *   ausência de contexto de distribuidora na mesma tabela.
 * - Múltiplos valores distintos para o mesmo rótulo → `null` (ambiguidade).
 * - Fontes (tabelas) distintas com endereços divergentes → `null`.
 */
export const addressFromTableCandidates = (
  candidates: readonly TableCandidate[],
): ExtractedAddress | null => {
  const bySource = new Map<string, TableCandidate[]>()
  for (const candidate of candidates) {
    const group = bySource.get(candidate.source) ?? []
    group.push(candidate)
    bySource.set(candidate.source, group)
  }

  const addresses = new Map<string, ExtractedAddress>()
  for (const group of bySource.values()) {
    const resolved = addressFromGroup(group)
    // Rótulo explícito ambíguo contamina o resultado: não há como provar qual
    // endereço é o de fornecimento.
    if (resolved.kind === 'ambiguous') return null
    if (resolved.kind === 'none') continue
    addresses.set(addressKey(resolved.value), resolved.value)
  }

  // Nenhuma fonte com endereço utilizável ou fontes divergentes → ausência.
  if (addresses.size !== 1) return null
  return [...addresses.values()][0] ?? null
}

/**
 * Extrai titular a partir de candidatos de tabela. Só rótulos explícitos de
 * titular/cliente/consumidor/pagador são aceitos; rótulos genéricos como
 * `NOME`, `EMPRESA` ou `FORNECEDOR` não identificam o consumidor.
 */
export const holderFromTableCandidates = (candidates: readonly TableCandidate[]): ExtractedHolder | null => {
  const holder = pickUniqueCandidate(candidates, [...HOLDER_LABELS])
  if (holder === null) return null
  return { name: holder.value, raw: holder.raw }
}

/**
 * Extrai número da instalação/unidade consumidora a partir de candidatos de
 * tabela. Retorna `null` quando ausente ou ambíguo.
 */
export const installationNumberFromTableCandidates = (
  candidates: readonly TableCandidate[],
): { readonly value: string; readonly raw: string } | null => {
  return pickUniqueCandidate(candidates, [...INSTALLATION_LABELS])
}
