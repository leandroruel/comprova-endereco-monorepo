import { describe, expect, it } from 'vitest'
import { policyHashOf } from './policy.js'
import { canonicalEvidenceSet, evidenceSetHash, type EvidenceSetEntry } from './provenance.js'

const base: EvidenceSetEntry = {
  id: 'aaaaaaaa-0000-0000-0000-000000000000',
  checker: 'cnefe',
  checkerVersion: '1',
  stance: 'supports',
  strength: 0.9,
  confidence: 0.8,
  source: 'cnefe',
  observedAt: '2026-01-01T00:00:00.000Z',
  evidenceSha256: null,
  detail: { a: 1, b: 'x' },
}

const withId = (id: string): EvidenceSetEntry => ({ ...base, id })

describe('evidenceSetHash', () => {
  it('é independente da ordem em que as observações são recuperadas', () => {
    const a = withId('cccccccc-0000-0000-0000-000000000000')
    const b = withId('aaaaaaaa-0000-0000-0000-000000000000')
    const c = withId('bbbbbbbb-0000-0000-0000-000000000000')
    expect(evidenceSetHash([a, b, c])).toBe(evidenceSetHash([c, a, b]))
    expect(canonicalEvidenceSet([a, b, c])).toBe(canonicalEvidenceSet([c, a, b]))
  })

  it('muda quando qualquer campo relevante da observação muda', () => {
    const hash = evidenceSetHash([base])
    expect(evidenceSetHash([{ ...base, strength: 0.5 }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, confidence: 0.1 }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, checker: 'other' }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, checkerVersion: '2' }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, stance: 'contradicts' }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, source: 'other' }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, observedAt: '2026-01-02T00:00:00.000Z' }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, detail: { a: 2, b: 'x' } }])).not.toBe(hash)
    expect(evidenceSetHash([{ ...base, evidenceSha256: 'ab'.repeat(32) }])).not.toBe(hash)
  })

  it('canonicaliza `detail` independentemente da ordem das chaves (jsonb)', () => {
    expect(evidenceSetHash([{ ...base, detail: { a: 1, b: 2 } }])).toBe(
      evidenceSetHash([{ ...base, detail: { b: 2, a: 1 } }]),
    )
  })

  it('depende apenas do digest durável, nunca do ponteiro material (evidence_id)', () => {
    // O tipo da entrada não possui `evidence_id`; o hash usa `evidenceSha256`.
    // Logo permanece reproduzível depois que a retenção anula o ponteiro.
    const entry: EvidenceSetEntry = { ...base, evidenceSha256: 'cd'.repeat(32) }
    expect(evidenceSetHash([entry])).toBe(evidenceSetHash([{ ...entry }]))
  })

  it('o conjunto vazio tem hash determinístico (mesma representação)', () => {
    expect(evidenceSetHash([])).toBe(evidenceSetHash([]))
    expect(evidenceSetHash([])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes diferentes para conjuntos diferentes', () => {
    expect(evidenceSetHash([withId('a')])).not.toBe(evidenceSetHash([withId('b')]))
    expect(evidenceSetHash([base])).not.toBe(evidenceSetHash([base, base]))
  })
})

describe('policyHashOf', () => {
  it('é estável para o mesmo conteúdo', () => {
    expect(policyHashOf('version: 1\nweights: {}')).toBe(policyHashOf('version: 1\nweights: {}'))
  })

  it('muda quando o conteúdo da policy muda', () => {
    expect(policyHashOf('version: 1\nweights: {}')).not.toBe(policyHashOf('version: 1\nweights: { a: 1 }'))
  })

  it('é um sha256 em hexadecimal', () => {
    expect(policyHashOf('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
