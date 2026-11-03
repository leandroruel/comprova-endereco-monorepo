/**
 * F1.2 — extração estruturada de tabelas e blocos do Marker.
 *
 * O Marker retorna páginas com elementos tipados (incluindo `table`). Este
 * módulo converte células de tabela em candidatos `rótulo: valor` e aplica a
 * mesma regra de ambiguidade do extrator baseado em texto (`fields.ts`):
 * rótulos repetidos com valores diferentes → ausência de extração.
 *
 * Não infere campos, não escolhe arbitrariamente entre múltiplos valores e não
 * altera a semântica do `DocumentAnalysisResult`.
 */

import { normalizeText, type ExtractedAddress, type ExtractedHolder } from '@comprova/core'
import type { DocumentIntelligenceTable } from '@comprova/contracts'

/**
 * Candidato extraído de uma célula de tabela. `page` é o número da página
 * (1-based) quando disponível.
 */
export interface TableCandidate {
  readonly label: string
  readonly value: string
  readonly raw: string
  readonly page: number
}

const labelOf = (value: string): string => normalizeText(value).replace(/[^A-Z0-9]/g, '')

/**
 * Rótulos reconhecidos em tabelas. São intencionalmente genéricos para não
 * criar regras específicas de uma distribuidora.
 */
const TABLE_LABELS: ReadonlySet<string> = new Set(
  [
    // Unidade / instalação
    'UNIDADECONSUMIDORA',
    'INSTALACAO',
    'NUMEROINSTALACAO',
    'NUMEROUNIDADE',
    'CODIGOUNIDADE',
    // Medidor
    'MEDIDOR',
    'NUMEROMEDIDOR',
    // Endereço
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
    // Titular
    'TITULAR',
    'NOMEDOTITULAR',
    'PAGADOR',
    'NOME',
    'CLIENTE',
    'RAZAOSOCIAL',
    // Concessionária/distribuidora
    'CONCESSIONARIA',
    'DISTRIBUIDORA',
    'EMPRESA',
    'FORNECEDOR',
  ].map(labelOf),
)

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

  for (const table of tables) {
    const headers = table.headers
    const dataRows = headers.length > 0 ? table.rows : table.rows.slice(1)
    const effectiveHeaders = headers.length > 0 ? headers : (table.rows[0] ?? [])

    for (const row of dataRows) {
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

/**
 * Extrai endereço de fornecimento a partir de candidatos de tabela.
 * Retorna `null` quando não há evidência suficiente ou há ambiguidade.
 *
 * Regras:
 * - Não confunde endereço de cobrança/correspondência com endereço de
 *   fornecimento sem distinção explícita (rótulo `ENDERECODECORRESPONDENCIA`
 *   é ignorado para endereço de instalação).
 * - Múltiplos valores distintos para o mesmo rótulo → `null` (ambiguidade).
 */
export const addressFromTableCandidates = (
  candidates: readonly TableCandidate[],
): ExtractedAddress | null => {
  const street = pickUniqueCandidate(candidates, ['LOGRADOURO', 'ENDERECO'])
  const number = pickUniqueCandidate(candidates, ['NUMERO'])
  const complement = pickUniqueCandidate(candidates, ['COMPLEMENTO'])
  const neighborhood = pickUniqueCandidate(candidates, ['BAIRRO'])
  const city = pickUniqueCandidate(candidates, ['CIDADE', 'MUNICIPIO'])
  const uf = pickUniqueCandidate(candidates, ['UF', 'ESTADO'])
  const cep = pickUniqueCandidate(candidates, ['CEP'])

  // Se nenhum campo foi encontrado, não há endereço na tabela.
  if (
    street === null &&
    number === null &&
    complement === null &&
    neighborhood === null &&
    city === null &&
    uf === null &&
    cep === null
  ) {
    return null
  }

  // Endereço parcial: apenas cidade/UF sem logradouro não é suficiente.
  if (street === null && city === null && uf === null) return null

  return {
    logradouro: street?.value ?? null,
    numero: number?.value ?? null,
    complemento: complement?.value ?? null,
    bairro: neighborhood?.value ?? null,
    cidade: city?.value ?? null,
    uf: uf?.value?.toUpperCase() ?? null,
    cep: cep?.value ?? null,
    raw: [street, number, complement, neighborhood, city, uf, cep]
      .filter((c) => c !== null)
      .map((c) => c!.raw)
      .join('; '),
  }
}

/**
 * Extrai titular a partir de candidatos de tabela.
 * Retorna `null` quando não há evidência suficiente ou há ambiguidade.
 */
export const holderFromTableCandidates = (candidates: readonly TableCandidate[]): ExtractedHolder | null => {
  const holder = pickUniqueCandidate(candidates, [
    'TITULAR',
    'NOMEDOTITULAR',
    'PAGADOR',
    'NOME',
    'CLIENTE',
    'RAZAOSOCIAL',
  ])
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
  return pickUniqueCandidate(candidates, [
    'UNIDADECONSUMIDORA',
    'INSTALACAO',
    'NUMEROINSTALACAO',
    'NUMEROUNIDADE',
    'CODIGOUNIDADE',
  ])
}
