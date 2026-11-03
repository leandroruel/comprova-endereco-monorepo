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
 * (1-based) quando disponível. `source` identifica a tabela e linha de origem
 * para evitar combinar campos de endereço de fontes distintas.
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
  // Agrupa candidatos por fonte (tabela de origem) para evitar combinar campos
  // de endereço de fontes distintas, ex.: endereço da distribuidora no
  // cabeçalho com o do cliente no corpo. Cada fonte é avaliada de forma
  // independente; só se combina campos dentro de uma mesma fonte.
  const bySource = new Map<string, TableCandidate[]>()
  for (const c of candidates) {
    const group = bySource.get(c.source) ?? []
    group.push(c)
    bySource.set(c.source, group)
  }

  // Cada fonte é avaliada isoladamente. Se duas fontes distintas produzirem
  // endereços diferentes, não há evidência de qual é o endereço de
  // fornecimento: o resultado é ambiguidade (ausência), nunca a escolha
  // arbitrária da fonte mais completa.
  const byFields = new Map<string, ExtractedAddress>()
  for (const group of bySource.values()) {
    const street = pickUniqueCandidate(group, ['LOGRADOURO', 'ENDERECO'])
    const number = pickUniqueCandidate(group, ['NUMERO'])
    const complement = pickUniqueCandidate(group, ['COMPLEMENTO'])
    const neighborhood = pickUniqueCandidate(group, ['BAIRRO'])
    const city = pickUniqueCandidate(group, ['CIDADE', 'MUNICIPIO'])
    const uf = pickUniqueCandidate(group, ['UF', 'ESTADO'])
    const cep = pickUniqueCandidate(group, ['CEP'])

    // Se nenhum campo foi encontrado nesta fonte, ignora-a.
    if (
      street === null &&
      number === null &&
      complement === null &&
      neighborhood === null &&
      city === null &&
      uf === null &&
      cep === null
    ) {
      continue
    }

    // Endereço parcial: apenas cidade/UF sem logradouro não é suficiente.
    if (street === null && city === null && uf === null) continue

    const addr: ExtractedAddress = {
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

    const key = [addr.logradouro, addr.numero, addr.complemento, addr.bairro, addr.cidade, addr.uf, addr.cep]
      .map((v) => v ?? '\u0000')
      .join('\u0001')
    byFields.set(key, addr)
  }

  // Nenhuma fonte com endereço utilizável ou fontes divergentes → ausência.
  if (byFields.size !== 1) return null
  return [...byFields.values()][0] ?? null
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
