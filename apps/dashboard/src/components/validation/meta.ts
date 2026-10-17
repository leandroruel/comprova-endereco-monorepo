import type { ValidationSignal } from '@/api/client'

export type Stance = ValidationSignal['stance']
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'
export type Detail = Readonly<Record<string, unknown>>
export type GroupId = 'registry' | 'address' | 'occupancy' | 'presence' | 'other'

export interface CheckerMeta {
  readonly label: string
  readonly description: string
  readonly group: GroupId
}

export const GROUPS: readonly { readonly id: GroupId; readonly title: string }[] = [
  { id: 'registry', title: 'Cadastro' },
  { id: 'address', title: 'Endereço' },
  { id: 'occupancy', title: 'Ocupação do imóvel' },
  { id: 'presence', title: 'Presença e fachada' },
  { id: 'other', title: 'Outras verificações' },
]

export const CHECKERS: Readonly<Record<string, CheckerMeta>> = {
  document_integrity: { label: 'Documento válido', description: 'Dígitos verificadores', group: 'registry' },
  registry_status: { label: 'Situação cadastral', description: 'Receita Federal', group: 'registry' },
  country_check: { label: 'País e UF', description: 'Localização do endereço', group: 'registry' },
  cep_consistency: { label: 'CEP', description: 'CEP, UF e município', group: 'address' },
  cnefe_match: { label: 'Censo do IBGE', description: 'Endereço no CNEFE', group: 'address' },
  geocode_consensus: { label: 'Geocodificação', description: 'Consenso entre provedores', group: 'address' },
  cotenancy: { label: 'Outros CNPJs no imóvel', description: 'Co-tenância', group: 'occupancy' },
  cnae_vs_location: { label: 'Atividade × local', description: 'CNAE e tipo de uso', group: 'occupancy' },
  places_match: {
    label: 'Estabelecimentos próximos',
    description: 'Pontos de interesse',
    group: 'occupancy',
  },
  partner_graph: { label: 'Rede de sócios', description: 'Padrões de fachada', group: 'occupancy' },
  digital_footprint: { label: 'Pegada digital', description: 'DDD e domínio de e-mail', group: 'presence' },
  street_view_vlm: { label: 'Fachada', description: 'Análise da imagem de rua', group: 'presence' },
}

export const STANCES: Readonly<Record<Stance, { readonly label: string; readonly tone: Tone }>> = {
  supports: { label: 'A favor', tone: 'success' },
  contradicts: { label: 'Contra', tone: 'danger' },
  neutral: { label: 'Neutro', tone: 'warning' },
  unknown: { label: 'Sem dados', tone: 'neutral' },
}

export interface VerdictMeta {
  readonly label: string
  readonly description: string
  readonly tone: Tone
}

export const VERDICTS: Readonly<Record<string, VerdictMeta>> = {
  CONFIRMED_COMMERCIAL: {
    label: 'Comercial confirmado',
    description: 'Endereço compatível com atividade comercial.',
    tone: 'success',
  },
  SHARED_VIRTUAL: {
    label: 'Endereço compartilhado',
    description: 'Escritório virtual, coworking ou endereço de contador.',
    tone: 'warning',
  },
  OCCUPIED_BY_OTHER_ENTITY: {
    label: 'Ocupado por outra empresa',
    description: 'Outro estabelecimento ativo no mesmo imóvel.',
    tone: 'danger',
  },
  RESIDENTIAL: {
    label: 'Aparenta residencial',
    description: 'O endereço parece uma residência comum.',
    tone: 'info',
  },
  NOT_FOUND: {
    label: 'Endereço não encontrado',
    description: 'Não foi possível confirmar o endereço.',
    tone: 'danger',
  },
  FOREIGN: { label: 'Endereço no exterior', description: 'O endereço fica fora do Brasil.', tone: 'info' },
  INCONSISTENT: {
    label: 'Sinais conflitantes',
    description: 'As evidências se contradizem. Requer revisão.',
    tone: 'danger',
  },
  INSUFFICIENT_EVIDENCE: {
    label: 'Evidência insuficiente',
    description: 'Não há evidência suficiente para concluir.',
    tone: 'neutral',
  },
}

export const FALLBACK_VERDICT: VerdictMeta = VERDICTS['INSUFFICIENT_EVIDENCE'] as VerdictMeta

export const CLAIM_LABELS: Readonly<Record<string, string>> = {
  business_registered_address: 'Endereço de registro da empresa',
  address_exists: 'Existência do endereço',
}

/** Códigos de espécie do CNEFE (IBGE). Confirme no dicionário de variáveis do IBGE antes de depender de algum além do 1. */
export const CNEFE_ESPECIE: Readonly<Record<number, string>> = {
  1: 'Domicílio particular',
  2: 'Domicílio coletivo',
  3: 'Estabelecimento agropecuário',
  4: 'Estabelecimento de ensino',
  5: 'Estabelecimento de saúde',
  6: 'Estabelecimento de outras finalidades',
  7: 'Edificação em construção',
  8: 'Estabelecimento religioso',
}

export const DETAIL_LABELS: Readonly<Record<string, string>> = {
  situacao: 'Situação',
  data_abertura: 'Abertura',
  country: 'País',
  uf: 'UF',
  cep: 'CEP',
  localidade: 'Localidade',
  match: 'Correspondência',
  cnefe_id: 'ID no CNEFE',
  especie: 'Tipo no censo',
  residential_hint: 'Indício residencial',
  active_cnpj_count: 'CNPJs ativos',
  distinct_cnae_div: 'Divisões CNAE',
  other_active_cnpjs: 'Outros CNPJs ativos',
  other_names: 'Nomes',
  same_unit: 'Mesma unidade',
  shared_kind: 'Tipo de compartilhamento',
  divisao: 'Divisão CNAE',
  categoria: 'Categoria',
  reason: 'Motivo',
  dispersion_m: 'Dispersão (m)',
  precision: 'Precisão',
  matched_poi: 'Estabelecimento',
  nearby_pois: 'Estabelecimentos próximos',
  ddd: 'DDD',
  expected_ufs: 'UFs esperadas',
  facade: 'Fachada',
  image_date: 'Data da imagem',
  other_business_name: 'Outro negócio',
  pattern: 'Padrão',
  cnpjs_sharing_partner: 'CNPJs com sócio em comum',
  recent_openings_at_address: 'Aberturas recentes',
  co_located_cnpjs: 'CNPJs no mesmo endereço',
}

export const HIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set(['verdict_hint', 'timeout_ms'])

export const REASONS: Readonly<Record<string, string>> = {
  not_in_registry: 'CNPJ não encontrado na base da Receita carregada.',
  cep_missing: 'CEP não informado.',
  address_not_resolved: 'Endereço ainda não normalizado para consulta.',
  no_building_key: 'Endereço sem chave de imóvel.',
  no_profile: 'Perfil de co-tenância ainda não calculado.',
  no_cnae: 'CNAE não disponível.',
  no_pois: 'Nenhum estabelecimento encontrado no entorno.',
  no_image: 'Sem imagem de rua disponível.',
}

export const BRAZIL = 'BR'

const pad = (n: number): string => String(n).padStart(2, '0')

const parseYmd = (iso: string): { y: number; m: number; d: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null
}

export const formatCep = (value: string): string => {
  const digits = value.replace(/\D+/g, '')
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : value
}

export const formatDate = (iso: string): string => {
  const ymd = parseYmd(iso)
  if (ymd) return `${pad(ymd.d)}/${pad(ymd.m)}/${ymd.y}`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('pt-BR')
}

export const formatAge = (iso: string, now: Date): string | null => {
  const ymd = parseYmd(iso)
  if (!ymd) return null
  const months =
    (now.getUTCFullYear() - ymd.y) * 12 + (now.getUTCMonth() + 1 - ymd.m) - (now.getUTCDate() < ymd.d ? 1 : 0)
  if (months < 0) return null
  if (months < 12) return months <= 1 ? 'menos de 1 mês' : `${months} meses`
  const years = Math.floor(months / 12)
  return years === 1 ? '1 ano' : `${years} anos`
}

export const formatRelative = (date: Date, now: Date): string => {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(seconds)
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
  if (abs < 45) return 'agora mesmo'
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour')
  return rtf.format(Math.round(seconds / 86_400), 'day')
}

export const formatTtl = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400)
  if (days >= 1) return days === 1 ? '1 dia' : `${days} dias`
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return hours === 1 ? '1 hora' : `${hours} horas`
  return `${Math.max(1, Math.floor(seconds / 60))} min`
}

export const formatPercent = (value: number): string => `${Math.round(value * 100)}%`

export const confidenceLevel = (value: number): { readonly label: string; readonly tone: Tone } =>
  value >= 0.8
    ? { label: 'alta', tone: 'success' }
    : value >= 0.55
      ? { label: 'média', tone: 'warning' }
      : { label: 'baixa', tone: 'danger' }

export const especieLabel = (value: unknown): string | null => {
  const n = Number(value)
  if (!Number.isInteger(n)) return null
  return `${n} · ${CNEFE_ESPECIE[n] ?? 'Espécie não mapeada'}`
}

export const formatValue = (key: string, value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'sim' : 'não'
  if (key === 'cep' && typeof value === 'string') return formatCep(value)
  if (key === 'data_abertura' && typeof value === 'string') return formatDate(value)
  if (key === 'country' && value === BRAZIL) return 'Brasil'
  if (key === 'especie') return especieLabel(value) ?? String(value)
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.slice(0, 6).map(String).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value).slice(0, 80)
}
