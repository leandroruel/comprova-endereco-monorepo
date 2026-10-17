import type { ValidationSignal } from '@/api/client'
import {
  BRAZIL,
  CHECKERS,
  DETAIL_LABELS,
  GROUPS,
  HIDDEN_DETAIL_KEYS,
  REASONS,
  especieLabel,
  formatAge,
  formatCep,
  formatDate,
  formatValue,
  type Detail,
  type GroupId,
  type Stance,
} from './meta'

export interface Fact {
  readonly label: string
  readonly value: string
}

export interface SignalView {
  readonly checker: string
  readonly label: string
  readonly description: string
  readonly group: GroupId
  readonly stance: Stance
  readonly summary: string
  /** Frase para a lista "Pontos de atenção"; nula quando não há nada a destacar. */
  readonly attention: string | null
  /** força × confiança, de 0 a 1 */
  readonly impact: number
  readonly facts: readonly Fact[]
  readonly signal: ValidationSignal
}

const text = (d: Detail, key: string): string | null => {
  const v = d[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

const num = (d: Detail, key: string): number | null => {
  const v = d[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const flag = (d: Detail, key: string): boolean | null => {
  const v = d[key]
  return typeof v === 'boolean' ? v : null
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const CATEGORIES: Readonly<Record<string, string>> = {
  MIXED: 'uso misto',
  COMMERCIAL: 'uso comercial',
  RESIDENTIAL: 'uso residencial',
  INDUSTRIAL: 'uso industrial',
}

const reasonOf = (d: Detail): string | null => {
  const reason = text(d, 'reason')
  return reason === null ? null : (REASONS[reason] ?? `Motivo: ${reason.replace(/_/g, ' ')}.`)
}

interface Described {
  readonly summary: string
  readonly attention?: string
}

const describe = (checker: string, stance: Stance, d: Detail, now: Date): Described => {
  const reason = reasonOf(d)
  switch (checker) {
    case 'document_integrity':
      return { summary: stance === 'supports' ? 'Dígitos verificadores válidos.' : 'Documento inválido.' }

    case 'registry_status': {
      if (text(d, 'reason') === 'not_in_registry') {
        const summary = REASONS['not_in_registry'] as string
        return { summary, attention: summary }
      }
      const situacao = text(d, 'situacao')
      if (situacao === null) return { summary: reason ?? 'Sem informação de situação cadastral.' }
      const since = text(d, 'data_abertura')
      if (situacao.toLowerCase() === 'ativa') {
        const age = since ? formatAge(since, now) : null
        return {
          summary: since
            ? `Cadastro ativo desde ${formatDate(since)}${age ? ` (${age})` : ''}.`
            : 'Cadastro ativo na Receita.',
        }
      }
      return { summary: `Situação cadastral: ${situacao}.`, attention: `Situação cadastral: ${situacao}.` }
    }

    case 'country_check': {
      const country = text(d, 'country')
      const uf = text(d, 'uf')
      if (country !== null && country !== BRAZIL) {
        const summary = `Endereço fora do Brasil (${country}).`
        return { summary, attention: summary }
      }
      return {
        summary:
          country === null
            ? (reason ?? 'País não identificado.')
            : `Endereço no Brasil${uf ? ` (${uf})` : ''}.`,
      }
    }

    case 'cep_consistency': {
      const cep = text(d, 'cep')
      const place = [text(d, 'localidade'), text(d, 'uf')].filter(Boolean).join('/')
      if (stance === 'supports' && cep) {
        return { summary: `CEP ${formatCep(cep)} confere${place ? ` com ${place}` : ''}.` }
      }
      if (stance === 'contradicts') {
        const summary = 'CEP, UF e município não são coerentes entre si.'
        return { summary, attention: summary }
      }
      return { summary: reason ?? 'CEP não verificado.' }
    }

    case 'cnefe_match': {
      const match = text(d, 'match')
      const especie = especieLabel(d['especie'])
      const residential = flag(d, 'residential_hint') === true
      const summary =
        match === 'exact_number'
          ? 'Número encontrado no censo do IBGE.'
          : match === 'street_only'
            ? 'Rua encontrada no censo, mas o número exato não consta.'
            : match !== null
              ? `Correspondência no censo: ${match.replace(/_/g, ' ')}.`
              : (reason ?? 'Sem correspondência no censo.')
      return residential
        ? {
            summary,
            attention: `O censo classifica o imóvel como ${especie ? especie.split(' · ')[1]?.toLowerCase() : 'residencial'} (uso residencial).`,
          }
        : { summary }
    }

    case 'geocode_consensus': {
      const dispersion = num(d, 'dispersion_m')
      if (dispersion === null) return { summary: reason ?? 'Sem coordenadas para comparar.' }
      return stance === 'contradicts'
        ? {
            summary: `Provedores divergem em ${Math.round(dispersion)} m.`,
            attention: `Provedores de mapa divergem em ${Math.round(dispersion)} m.`,
          }
        : { summary: `Provedores concordam (dispersão de ${Math.round(dispersion)} m).` }
    }

    case 'cotenancy': {
      const others = num(d, 'other_active_cnpjs')
      const kind = text(d, 'shared_kind')
      const active = num(d, 'active_cnpj_count')
      if (kind !== null) {
        const summary = `Endereço compartilhado (${kind})${active !== null ? `, ${plural(active, 'CNPJ ativo', 'CNPJs ativos')}` : ''}.`
        return { summary, attention: summary }
      }
      if (others !== null && others > 0) {
        const summary = `${plural(others, 'outro CNPJ ativo', 'outros CNPJs ativos')} no mesmo imóvel.`
        return { summary, attention: summary }
      }
      if (others === 0) return { summary: 'Nenhum outro CNPJ ativo no mesmo imóvel.' }
      return { summary: reason ?? 'Sem dados de ocupação do imóvel.' }
    }

    case 'cnae_vs_location': {
      const divisao = text(d, 'divisao') ?? (num(d, 'divisao') !== null ? String(num(d, 'divisao')) : null)
      const categoria = text(d, 'categoria')
      if (divisao === null && categoria === null) return { summary: reason ?? 'Sem dados de CNAE.' }
      const label = categoria ? (CATEGORIES[categoria] ?? categoria.toLowerCase()) : 'categoria não informada'
      const summary = `Atividade${divisao ? ` (divisão ${divisao})` : ''} classificada como ${label}.`
      return stance === 'contradicts'
        ? { summary, attention: `${summary} Pode não combinar com o local.` }
        : { summary }
    }

    case 'places_match': {
      const poi = text(d, 'matched_poi')
      const nearby = Array.isArray(d['nearby_pois']) ? d['nearby_pois'].length : num(d, 'nearby_pois')
      if (poi) return { summary: `Estabelecimento correspondente no entorno: ${poi}.` }
      if (nearby !== null)
        return {
          summary: `${plural(nearby, 'estabelecimento próximo', 'estabelecimentos próximos')}, sem correspondência.`,
        }
      return { summary: reason ?? 'Sem estabelecimentos para comparar.' }
    }

    case 'digital_footprint': {
      const ddd = text(d, 'ddd') ?? (num(d, 'ddd') !== null ? String(num(d, 'ddd')) : null)
      if (ddd === null) return { summary: reason ?? 'Sem telefone ou domínio para comparar.' }
      return stance === 'contradicts'
        ? {
            summary: `DDD ${ddd} não condiz com a UF do endereço.`,
            attention: `DDD ${ddd} não condiz com a UF do endereço.`,
          }
        : { summary: `DDD ${ddd} condiz com a UF do endereço.` }
    }

    case 'street_view_vlm': {
      const facade = text(d, 'facade')
      const date = text(d, 'image_date')
      const other = text(d, 'other_business_name')
      if (facade === null) return { summary: reason ?? 'Sem análise de fachada.' }
      const summary = `Fachada: ${facade.replace(/_/g, ' ')}${date ? ` (imagem de ${date})` : ''}.`
      return other
        ? { summary, attention: `A fachada exibe outro negócio: ${other.slice(0, 60)}.` }
        : { summary }
    }

    case 'partner_graph': {
      const pattern = text(d, 'pattern')
      if (pattern === null) return { summary: reason ?? 'Nenhum padrão suspeito de sócios.' }
      const summary = `Padrão detectado: ${pattern.replace(/_/g, ' ')}.`
      return stance === 'contradicts' ? { summary, attention: summary } : { summary }
    }

    default: {
      if (reason) return { summary: reason }
      const first = Object.entries(d).find(([k]) => !HIDDEN_DETAIL_KEYS.has(k))
      return {
        summary: first
          ? `${DETAIL_LABELS[first[0]] ?? first[0]}: ${formatValue(first[0], first[1])}`
          : 'Sem detalhes.',
      }
    }
  }
}

export const describeSignal = (signal: ValidationSignal, now: Date): SignalView => {
  const meta = CHECKERS[signal.checker]
  const detail = signal.detail
  const described = describe(signal.checker, signal.stance, detail, now)
  const facts = Object.entries(detail)
    .filter(([key]) => !HIDDEN_DETAIL_KEYS.has(key))
    .map(([key, value]) => ({
      label: DETAIL_LABELS[key] ?? key.replace(/_/g, ' '),
      value: formatValue(key, value),
    }))

  // Neutro e sem dados só chamam atenção quando a frase destaca algo concreto.
  const attention =
    signal.stance === 'supports'
      ? null
      : (described.attention ?? (signal.stance === 'contradicts' ? described.summary : null))

  return {
    checker: signal.checker,
    label: meta?.label ?? signal.checker.replace(/_/g, ' '),
    description: meta?.description ?? '',
    group: meta?.group ?? 'other',
    stance: signal.stance,
    summary: described.summary,
    attention,
    impact: Math.max(0, Math.min(1, signal.strength * signal.confidence)),
    facts,
    signal,
  }
}

export interface StanceCounts {
  readonly supports: number
  readonly contradicts: number
  readonly neutral: number
  readonly unknown: number
}

export const countStances = (views: readonly SignalView[]): StanceCounts => ({
  supports: views.filter((v) => v.stance === 'supports').length,
  contradicts: views.filter((v) => v.stance === 'contradicts').length,
  neutral: views.filter((v) => v.stance === 'neutral').length,
  unknown: views.filter((v) => v.stance === 'unknown').length,
})

export interface ViewGroup {
  readonly id: GroupId
  readonly title: string
  readonly views: readonly SignalView[]
}

export const groupViews = (views: readonly SignalView[]): readonly ViewGroup[] =>
  GROUPS.map((group) => ({ ...group, views: views.filter((v) => v.group === group.id) })).filter(
    (g) => g.views.length > 0,
  )

export interface SnapshotItem {
  readonly label: string
  readonly value: string | null
  readonly tone: 'ok' | 'warn' | 'muted'
}

/** Resumo "de relance" do cadastro, extraído dos sinais. `null` indica dado ausente. */
export const buildSnapshot = (views: readonly SignalView[], now: Date): readonly SnapshotItem[] => {
  const detailOf = (checker: string): Detail => views.find((v) => v.checker === checker)?.signal.detail ?? {}
  const registry = detailOf('registry_status')
  const country = detailOf('country_check')
  const cep = detailOf('cep_consistency')
  const cnefe = detailOf('cnefe_match')
  const cnae = detailOf('cnae_vs_location')
  const cotenancy = views.find((v) => v.checker === 'cotenancy')

  const situacao = text(registry, 'situacao')
  const since = text(registry, 'data_abertura')
  const age = since ? formatAge(since, now) : null
  const cepValue = text(cep, 'cep')
  const place = [text(cep, 'localidade'), text(cep, 'uf') ?? text(country, 'uf')].filter(Boolean).join('/')
  const countryCode = text(country, 'country')
  const especie = especieLabel(cnefe['especie'])
  const divisao =
    text(cnae, 'divisao') ?? (num(cnae, 'divisao') !== null ? String(num(cnae, 'divisao')) : null)
  const categoria = text(cnae, 'categoria')

  return [
    {
      label: 'Situação cadastral',
      value: situacao ? situacao.charAt(0).toUpperCase() + situacao.slice(1) : null,
      tone: situacao === null ? 'muted' : situacao.toLowerCase() === 'ativa' ? 'ok' : 'warn',
    },
    {
      label: 'Abertura',
      value: since ? `${formatDate(since)}${age ? ` · ${age}` : ''}` : null,
      tone: since ? 'ok' : 'muted',
    },
    {
      label: 'CEP',
      value: cepValue ? `${formatCep(cepValue)}${place ? ` · ${place}` : ''}` : null,
      tone: cepValue ? 'ok' : 'muted',
    },
    {
      label: 'País',
      value: countryCode ? (countryCode === BRAZIL ? 'Brasil' : countryCode) : null,
      tone: countryCode === null ? 'muted' : countryCode === BRAZIL ? 'ok' : 'warn',
    },
    {
      label: 'Tipo no censo',
      value: especie,
      tone: especie === null ? 'muted' : flag(cnefe, 'residential_hint') === true ? 'warn' : 'ok',
    },
    {
      label: 'Atividade (CNAE)',
      value:
        divisao || categoria
          ? `${divisao ? `Divisão ${divisao}` : ''}${divisao && categoria ? ' · ' : ''}${categoria ? (CATEGORIES[categoria] ?? categoria.toLowerCase()) : ''}`
          : null,
      tone: divisao || categoria ? 'ok' : 'muted',
    },
    {
      label: 'Outros CNPJs no imóvel',
      value: cotenancy && cotenancy.stance !== 'unknown' ? cotenancy.summary : null,
      tone:
        cotenancy === undefined || cotenancy.stance === 'unknown'
          ? 'muted'
          : cotenancy.attention
            ? 'warn'
            : 'ok',
    },
  ]
}
