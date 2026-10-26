import { describe, expect, it } from 'vitest'
import type { Signal } from '@comprova/core'
import {
  assessmentObservationsOf,
  canonicalStandaloneEvidence,
  outcomeSupersedesCredentials,
  type NextCredentialOutcome,
  type PriorCredentialOutcome,
} from './deep-enrich.service.js'
import type { StandaloneEvidenceRow } from './deep-enrich.persistence.js'

const previous = (overrides: Partial<PriorCredentialOutcome> = {}): PriorCredentialOutcome => ({
  status: 'completed',
  verdict: 'CONFIRMED_COMMERCIAL',
  evidenceSetHash: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  scorerVersion: '1',
  ...overrides,
})

const next = (overrides: Partial<NextCredentialOutcome> = {}): NextCredentialOutcome => ({
  stillPartial: false,
  verdict: 'CONFIRMED_COMMERCIAL',
  evidenceSetHash: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  scorerVersion: '1',
  ...overrides,
})

const signalOf = (overrides: Partial<Signal> = {}): Signal => ({
  checkerId: 'document_integrity',
  checkerVersion: '1.0.0',
  stance: 'neutral',
  strength: 0.5,
  confidence: 0.8,
  source: 'uploaded_document',
  observedAt: '2026-10-23T12:00:00.000Z',
  ttlSeconds: 86_400,
  detail: { reason: 'ok' },
  ...overrides,
})

const standaloneOf = (overrides: Partial<StandaloneEvidenceRow> = {}): StandaloneEvidenceRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  checker: 'nf3e_verification',
  checkerVersion: '1.0.0+dabc+c1',
  stance: 'supports',
  strength: 0,
  confidence: 0,
  source: 'fiscal_nf3e',
  observedAt: new Date('2026-10-23T12:00:00.000Z'),
  ttlSeconds: 3600,
  detail: { verification: { document: 'authentic' } },
  createdAt: new Date('2026-10-23T12:00:00.000Z'),
  ...overrides,
})

describe('assessmentObservationsOf', () => {
  it('inclui observações sem signal (fiscal/upload) na avaliação existente', () => {
    const observations = assessmentObservationsOf([signalOf()], [standaloneOf()])

    expect(observations.map((observation) => observation.checker)).toEqual([
      'document_integrity',
      'nf3e_verification',
    ])
    expect(observations[1]).toEqual({
      checker: 'nf3e_verification',
      checkerVersion: '1.0.0+dabc+c1',
      stance: 'supports',
      strength: 0,
      confidence: 0,
      source: 'fiscal_nf3e',
      observedAt: '2026-10-23T12:00:00.000Z',
      ttlSeconds: 3600,
      detail: { verification: { document: 'authentic' } },
    })
  })

  it('preserva a fidelidade de stance dos signals (neutral não vira unknown)', () => {
    const [observation] = assessmentObservationsOf([signalOf({ stance: 'neutral' })], [])
    expect(observation?.stance).toBe('neutral')
  })
})

const fiscalRow = (
  documentRefHash: string,
  checkerVersion: string,
  overrides: Partial<StandaloneEvidenceRow> = {},
): StandaloneEvidenceRow =>
  standaloneOf({
    checkerVersion,
    detail: { verification: { document: 'authentic', document_ref_hash: documentRefHash } },
    ...overrides,
  })

describe('canonicalStandaloneEvidence (dedup de versão fiscal para scoring)', () => {
  it('uma única versão permanece inalterada', () => {
    const rows = [fiscalRow('doc-a', '1.0.0+dabc')]
    expect(canonicalStandaloneEvidence(rows)).toHaveLength(1)
  })

  it('colapsa duas versões do mesmo documento em uma só observação', () => {
    const rows = [fiscalRow('doc-a', '2.0.0+dabc'), fiscalRow('doc-a', '1.0.0+dabc')]
    const canonical = canonicalStandaloneEvidence(rows)
    expect(canonical).toHaveLength(1)
    // a primeira (mais recente, já ordenada pela leitura) é a canônica
    expect(canonical[0]?.checkerVersion).toBe('2.0.0+dabc')
  })

  it('colapsa três versões do mesmo documento em uma só', () => {
    const rows = [
      fiscalRow('doc-a', '3.0.0+dabc'),
      fiscalRow('doc-a', '2.0.0+dabc'),
      fiscalRow('doc-a', '1.0.0+dabc'),
    ]
    expect(canonicalStandaloneEvidence(rows)).toHaveLength(1)
  })

  it('não deduplica documentos diferentes', () => {
    const rows = [fiscalRow('doc-a', '1.0.0+dabc'), fiscalRow('doc-b', '1.0.0+defg')]
    expect(canonicalStandaloneEvidence(rows)).toHaveLength(2)
  })

  it('não deduplica evidências não fiscais, mesmo com document_ref_hash', () => {
    const nonFiscal = standaloneOf({
      checker: 'customer_submitted_document_verification',
      checkerVersion: '1.0.0',
      source: 'customer_submitted_document',
      detail: { verification: { document_ref_hash: 'doc-a' } },
    })
    const rows = [nonFiscal, { ...nonFiscal, id: '00000000-0000-4000-8000-000000000002' }]
    expect(canonicalStandaloneEvidence(rows)).toHaveLength(2)
  })

  it('a versão mais recente prevalece mesmo quando o stance muda entre versões', () => {
    // Ordenadas como a leitura retorna (mais recente primeiro): v2 unknown,
    // v1 supports. Só v2 entra no score — a contribuição positiva antiga morre.
    const v2Unknown = fiscalRow('doc-a', '2.0.0+dabc', { stance: 'unknown' })
    const v1Supports = fiscalRow('doc-a', '1.0.0+dabc')
    const canonical = canonicalStandaloneEvidence([v2Unknown, v1Supports])
    expect(canonical).toHaveLength(1)
    expect(canonical[0]?.checkerVersion).toBe('2.0.0+dabc')
    expect(canonical[0]?.stance).toBe('unknown')
  })

  it('versão mais recente supports substitui versão antiga unknown', () => {
    const v2Supports = fiscalRow('doc-a', '2.0.0+dabc')
    const v1Unknown = fiscalRow('doc-a', '1.0.0+dabc', { stance: 'unknown' })
    const canonical = canonicalStandaloneEvidence([v2Supports, v1Unknown])
    expect(canonical).toHaveLength(1)
    expect(canonical[0]?.checkerVersion).toBe('2.0.0+dabc')
    expect(canonical[0]?.stance).toBe('supports')
  })

  it('mantém linhas sem document_ref_hash intactas', () => {
    const noHash = standaloneOf({ detail: { verification: { document: 'authentic' } } })
    const rows = [noHash, { ...noHash, id: '00000000-0000-4000-8000-000000000003' }]
    expect(canonicalStandaloneEvidence(rows)).toHaveLength(2)
  })
})

describe('outcomeSupersedesCredentials (C1)', () => {
  it('não revoga sem conclusão anterior', () => {
    expect(outcomeSupersedesCredentials(previous({ status: 'queued' }), next())).toBe(false)
    expect(outcomeSupersedesCredentials(previous({ status: 'partial' }), next())).toBe(false)
  })

  it('replay idêntico NÃO revoga', () => {
    expect(outcomeSupersedesCredentials(previous(), next())).toBe(false)
  })

  it('mudança de veredito, evidências, policy ou scorer revoga', () => {
    expect(outcomeSupersedesCredentials(previous(), next({ verdict: 'NOT_FOUND' }))).toBe(true)
    expect(outcomeSupersedesCredentials(previous(), next({ evidenceSetHash: 'c'.repeat(64) }))).toBe(true)
    expect(outcomeSupersedesCredentials(previous(), next({ policyHash: 'd'.repeat(64) }))).toBe(true)
    expect(outcomeSupersedesCredentials(previous(), next({ scorerVersion: '2' }))).toBe(true)
  })

  it('voltar a parcial depois de concluída revoga', () => {
    expect(outcomeSupersedesCredentials(previous(), next({ stillPartial: true }))).toBe(true)
  })
})
