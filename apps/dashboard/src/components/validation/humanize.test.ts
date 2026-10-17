import { describe, expect, it } from 'vitest'
import type { ValidationSignal } from '@/api/client'
import { buildSnapshot, countStances, describeSignal, groupViews } from './humanize'
import { confidenceLevel, formatAge, formatCep, formatDate, formatRelative, formatTtl } from './meta'

const NOW = new Date('2026-10-17T12:00:00Z')

const sig = (
  checker: string,
  stance: ValidationSignal['stance'],
  detail: Record<string, unknown> = {},
  strength = 0.5,
  confidence = 0.9,
): ValidationSignal => ({
  checker,
  checker_version: '1.0.0',
  stance,
  strength,
  confidence,
  source: 'test',
  observed_at: NOW.toISOString(),
  ttl_seconds: 86_400,
  detail,
  evidence_id: null,
})

const view = (s: ValidationSignal) => describeSignal(s, NOW)

describe('describeSignal', () => {
  it('cadastro ativo mostra data e idade', () => {
    const v = view(sig('registry_status', 'supports', { situacao: 'ativa', data_abertura: '2019-06-20' }))
    expect(v.summary).toBe('Cadastro ativo desde 20/06/2019 (7 anos).')
    expect(v.attention).toBeNull()
  })

  it('CNPJ fora da base vira ponto de atenção', () => {
    const v = view(sig('registry_status', 'unknown', { reason: 'not_in_registry' }, 0, 0.5))
    expect(v.attention).toMatch(/não encontrado na base da Receita/)
  })

  it('CNEFE: rua sem número exato + indício residencial', () => {
    const v = view(
      sig('cnefe_match', 'neutral', {
        match: 'street_only',
        especie: 1,
        residential_hint: true,
        cnefe_id: 60180802,
      }),
    )
    expect(v.summary).toBe('Rua encontrada no censo, mas o número exato não consta.')
    expect(v.attention).toMatch(/domicílio particular/)
    expect(v.facts.find((f) => f.label === 'Tipo no censo')?.value).toBe('1 · Domicílio particular')
  })

  it('sem dados traduz o motivo e não vira atenção', () => {
    const v = view(sig('cotenancy', 'unknown', { reason: 'no_profile' }, 0, 0.4))
    expect(v.summary).toBe('Perfil de co-tenância ainda não calculado.')
    expect(v.attention).toBeNull()
  })

  it('neutro sem destaque não vira atenção; contrário sempre vira', () => {
    expect(
      view(sig('cnae_vs_location', 'neutral', { divisao: '82', categoria: 'MIXED' })).attention,
    ).toBeNull()
    const against = view(sig('cotenancy', 'contradicts', { other_active_cnpjs: 2 }))
    expect(against.summary).toBe('2 outros CNPJs ativos no mesmo imóvel.')
    expect(against.attention).toBe(against.summary)
  })

  it('peso é força × confiança limitado a 0..1', () => {
    expect(view(sig('document_integrity', 'supports', {}, 0.5, 1)).impact).toBe(0.5)
    expect(view(sig('document_integrity', 'supports', {}, 2, 2)).impact).toBe(1)
  })

  it('checker desconhecido tem fallback legível e esconde chaves técnicas', () => {
    const v = view(
      sig('novo_checker', 'neutral', { foo_bar: 'x', verdict_hint: 'RESIDENTIAL', timeout_ms: 25 }),
    )
    expect(v.label).toBe('novo checker')
    expect(v.group).toBe('other')
    expect(v.facts.map((f) => f.label)).toEqual(['foo bar'])
  })
})

describe('agregações', () => {
  const views = [
    sig('document_integrity', 'supports'),
    sig('registry_status', 'supports', { situacao: 'ativa', data_abertura: '2019-06-20' }),
    sig('country_check', 'supports', { country: 'BR', uf: 'SP' }),
    sig('cep_consistency', 'supports', { cep: '08295090', uf: 'SP', localidade: 'São Paulo' }),
    sig('cnefe_match', 'neutral', { match: 'street_only', especie: 1, residential_hint: true }),
    sig('cotenancy', 'unknown', { reason: 'no_profile' }),
    sig('cnae_vs_location', 'neutral', { divisao: '82', categoria: 'MIXED' }),
  ].map(view)

  it('conta os quatro estados (o neutro não some)', () => {
    expect(countStances(views)).toEqual({ supports: 4, contradicts: 0, neutral: 2, unknown: 1 })
  })

  it('agrupa por categoria, na ordem definida, sem grupos vazios', () => {
    expect(groupViews(views).map((g) => [g.id, g.views.length])).toEqual([
      ['registry', 3],
      ['address', 2],
      ['occupancy', 2],
    ])
  })

  it('resumo do cadastro', () => {
    const byLabel = Object.fromEntries(buildSnapshot(views, NOW).map((i) => [i.label, i]))
    expect(byLabel['Situação cadastral']).toMatchObject({ value: 'Ativa', tone: 'ok' })
    expect(byLabel['Abertura']?.value).toBe('20/06/2019 · 7 anos')
    expect(byLabel['CEP']?.value).toBe('08295-090 · São Paulo/SP')
    expect(byLabel['Tipo no censo']).toMatchObject({ value: '1 · Domicílio particular', tone: 'warn' })
    expect(byLabel['Atividade (CNAE)']?.value).toBe('Divisão 82 · uso misto')
    expect(byLabel['Outros CNPJs no imóvel']).toMatchObject({ value: null, tone: 'muted' })
  })
})

describe('formatadores', () => {
  it('CEP, data e TTL', () => {
    expect(formatCep('08295090')).toBe('08295-090')
    expect(formatCep('abc')).toBe('abc')
    expect(formatDate('2019-06-20')).toBe('20/06/2019')
    expect(formatTtl(2_592_000)).toBe('30 dias')
    expect(formatTtl(7200)).toBe('2 horas')
  })
  it('idade', () => {
    expect(formatAge('2026-09-01', NOW)).toBe('menos de 1 mês')
    expect(formatAge('2026-05-10', NOW)).toBe('5 meses')
    expect(formatAge('2025-10-17', NOW)).toBe('1 ano')
  })
  it('tempo relativo', () => {
    expect(formatRelative(new Date(NOW.getTime() - 10_000), NOW)).toBe('agora mesmo')
    expect(formatRelative(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('há 5 minutos')
  })
  it('níveis de confiança', () => {
    expect(confidenceLevel(0.89).label).toBe('alta')
    expect(confidenceLevel(0.6).label).toBe('média')
    expect(confidenceLevel(0.3).label).toBe('baixa')
  })
})
