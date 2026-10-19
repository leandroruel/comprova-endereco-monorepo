import { describe, expect, it } from 'vitest'
import type { AssertionPayload } from './assertion.schema.js'
import { issuerIdOf } from '../service/issuer.service.js'
import { observationOfEvidence, toVerifiableCredential } from '../service/credential.service.js'
import {
  COMPROVA_CONTEXT_URL,
  COMPROVA_CREDENTIAL_TYPE,
  COMPROVA_EVIDENCE_TYPE,
  SecuredVerifiableCredentialSchema,
  urnUuidOf,
  uuidOfUrn,
  VC_CONTEXT_URL,
  VerifiableCredentialSchema,
} from './credential.schema.js'
import { CREDENTIAL_STATUS_TYPE } from './status.schema.js'

const ISSUER_ORIGIN = 'https://issuer.test'
const TENANT = '11111111-1111-4111-8111-111111111111'
const ISSUER_ID = issuerIdOf(ISSUER_ORIGIN, TENANT)
const SUBJECT_ID = `${ISSUER_ID}/subjects/${'a'.repeat(64)}`
/** id público opaco usado nos testes de mapping (não deriva de validation_id aqui). */
const CREDENTIAL_ID = 'e'.repeat(43)

const assertion = (overrides: Partial<AssertionPayload> = {}): AssertionPayload => ({
  format: 'comprova-assertion-v1',
  issuer: {
    id: ISSUER_ID,
    authorization: { scopes: ['validate:write', 'validate:read'] },
  },
  subject: { id: SUBJECT_ID, doc_type: 'CNPJ' },
  claim: {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'business_registered_address',
    subject_type: 'organization',
    target: {
      type: 'address',
      id: '33333333-3333-4333-8333-333333333333',
      building_key: 'b64:AAAA',
    },
  },
  evidence: {
    set_hash: 'b'.repeat(64),
    summary: { supporting: 1, contradicting: 0, unknown: 0 },
    observations: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        checker: 'registry_match',
        checker_version: '1',
        stance: 'supports',
        strength: 0.9,
        confidence: 0.8,
        source: 'receita',
        observed_at: '2026-01-02T03:04:05.000Z',
        evidence_sha256: 'c'.repeat(64),
        detail: { nested: { b: 2, a: 1 }, list: [1, 'two', null], unicode: 'São Paulo — çãõ' },
      },
    ],
  },
  policy: { version: '2026.13.1', hash: 'd'.repeat(64) },
  algorithm: { scorer_version: '1' },
  result: {
    status: 'completed',
    verdict: 'CONFIRMED_COMMERCIAL',
    score: 0.1,
    confidence: 0.8,
    explanation: {
      code: 'ADDRESS_CONFIRMED',
      summary: 'ok',
      supporting_evidence: ['44444444-4444-4444-8444-444444444444'],
      contradicting_evidence: [],
    },
  },
  legal_basis: 'FRAUD_PREVENTION',
  timestamps: {
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    expires_at: '2026-01-31T00:00:00.000Z',
  },
  ...overrides,
})

const credentialOf = (overrides: Partial<AssertionPayload> = {}) =>
  toVerifiableCredential(assertion(overrides), CREDENTIAL_ID)

describe('toVerifiableCredential (W3C VC Data Model 2.0)', () => {
  it('produz um documento conforme com o contexto base e os tipos W3C', () => {
    const vc = credentialOf()

    expect(vc['@context'][0]).toBe(VC_CONTEXT_URL)
    expect(vc['@context'][1]).toEqual({ comprova: COMPROVA_CONTEXT_URL })
    expect(vc.type).toEqual(['VerifiableCredential', COMPROVA_CREDENTIAL_TYPE])
    expect(vc.issuer).toBe(ISSUER_ID)
    expect(vc.issuer).toMatch(/^https:\/\/issuer\.test\/issuers\//)
    expect(vc.id).toBe(`${ISSUER_ID}/credentials/${CREDENTIAL_ID}`)
    expect(vc.credentialStatus).toEqual({
      id: `${ISSUER_ID}/credentials/${CREDENTIAL_ID}/status`,
      type: CREDENTIAL_STATUS_TYPE,
    })
    expect(VerifiableCredentialSchema.safeParse(vc).success).toBe(true)
  })

  it('exige o tipo de status suportado e rejeita campos extras', () => {
    const vc = credentialOf()
    expect(vc.credentialStatus).toBeDefined()

    expect(
      VerifiableCredentialSchema.safeParse({
        ...vc,
        credentialStatus: { ...vc.credentialStatus!, type: 'StatusList2021Entry' },
      }).success,
    ).toBe(false)
    expect(
      VerifiableCredentialSchema.safeParse({
        ...vc,
        credentialStatus: { ...vc.credentialStatus!, extra: true },
      }).success,
    ).toBe(false)
  })

  it('`validFrom` é a conclusão da validation (início da validade do veredito)', () => {
    const vc = credentialOf()

    expect(vc.validFrom).toBe('2026-01-01T00:00:01.000Z')
    expect(vc.validUntil).toBe('2026-01-31T00:00:00.000Z')
    expect(vc['comprova:result']['comprova:completedAt']).toBe('2026-01-01T00:00:01.000Z')
  })

  it('`validFrom` é `completed_at` — nunca `created_at` (início da requisição)', () => {
    const vc = credentialOf({
      timestamps: {
        created_at: '2026-01-01T00:00:00.000Z',
        // Análise demorada: a conclusão é 5 min depois do início.
        completed_at: '2026-01-01T00:05:00.000Z',
        expires_at: '2026-01-31T00:00:00.000Z',
      },
    })

    expect(vc.validFrom).toBe('2026-01-01T00:05:00.000Z')
    expect(vc.validFrom).not.toBe('2026-01-01T00:00:00.000Z')
    expect(vc['comprova:result']['comprova:completedAt']).toBe('2026-01-01T00:05:00.000Z')
  })

  it('mapeia o subject sem expor o material de identidade', () => {
    const vc = credentialOf()
    expect(vc.credentialSubject.id).toBe(SUBJECT_ID)
    expect(vc.credentialSubject.id).toBe(`${ISSUER_ID}/subjects/${'a'.repeat(64)}`)
    expect(vc.credentialSubject['comprova:docType']).toBe('CNPJ')
  })

  it('mapeia claim e endereço preservando `building_key` como binding', () => {
    const vc = credentialOf()
    const claim = vc.credentialSubject['comprova:claim']
    expect(claim.id).toBe('urn:uuid:22222222-2222-4222-8222-222222222222')
    expect(claim['comprova:claimType']).toBe('business_registered_address')
    expect(claim['comprova:subjectType']).toBe('organization')
    expect(claim['comprova:targetType']).toBe('address')
    expect(claim['comprova:address']).toEqual({
      id: 'urn:uuid:33333333-3333-4333-8333-333333333333',
      'comprova:buildingKey': 'b64:AAAA',
    })
  })

  it('mapeia a evidência para a propriedade W3C `evidence` (id + type + binding durável)', () => {
    const vc = credentialOf()
    expect(vc.evidence).toHaveLength(1)
    expect(vc.evidence[0]).toEqual({
      id: 'urn:uuid:44444444-4444-4444-8444-444444444444',
      type: [COMPROVA_EVIDENCE_TYPE],
      'comprova:checker': 'registry_match',
      'comprova:checkerVersion': '1',
      'comprova:stance': 'supports',
      'comprova:strength': 0.9,
      'comprova:confidence': 0.8,
      'comprova:source': 'receita',
      'comprova:observedAt': '2026-01-02T03:04:05.000Z',
      'comprova:evidenceSha256': 'c'.repeat(64),
      'comprova:detail': { nested: { b: 2, a: 1 }, list: [1, 'two', null], unicode: 'São Paulo — çãõ' },
    })
    expect(vc['comprova:evidenceSetHash']).toBe('b'.repeat(64))
  })

  it('expressa todo `id` como URL (`urn:uuid:`) e o desfaz para o evidence_set_hash', () => {
    const vc = credentialOf()
    const claim = vc.credentialSubject['comprova:claim']

    // §4.4: `id` precisa ser uma URL (nunca um UUID nu).
    expect(vc.evidence[0]!.id).toBe(urnUuidOf('44444444-4444-4444-8444-444444444444'))
    expect(claim.id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(claim['comprova:address'].id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(vc['comprova:result']['comprova:explanation']?.['comprova:supportingEvidence']).toEqual([
      urnUuidOf('44444444-4444-4444-8444-444444444444'),
    ])

    // O domínio (e portanto o hash) continua com UUIDs: a conversão é do mapping.
    expect(uuidOfUrn(vc.evidence[0]!.id)).toBe('44444444-4444-4444-8444-444444444444')
    expect(observationOfEvidence(vc.evidence[0]!).id).toBe('44444444-4444-4444-8444-444444444444')

    // Um `id` que não seja URL não é aceito pelo schema.
    expect(
      VerifiableCredentialSchema.safeParse({
        ...vc,
        evidence: [{ ...vc.evidence[0]!, id: '44444444-4444-4444-8444-444444444444' }],
      }).success,
    ).toBe(false)
  })

  it('mapeia resultado, policy, algoritmo, autorização e base legal', () => {
    const vc = credentialOf()
    expect(vc['comprova:result']).toEqual({
      'comprova:verdict': 'CONFIRMED_COMMERCIAL',
      'comprova:score': 0.1,
      'comprova:confidence': 0.8,
      'comprova:completedAt': '2026-01-01T00:00:01.000Z',
      'comprova:explanation': {
        'comprova:code': 'ADDRESS_CONFIRMED',
        'comprova:summary': 'ok',
        'comprova:supportingEvidence': ['urn:uuid:44444444-4444-4444-8444-444444444444'],
        'comprova:contradictingEvidence': [],
      },
    })
    expect(vc['comprova:policy']).toEqual({
      'comprova:version': '2026.13.1',
      'comprova:hash': 'd'.repeat(64),
    })
    expect(vc['comprova:algorithm']).toEqual({ 'comprova:scorerVersion': '1' })
    expect(vc['comprova:authorization']).toEqual({ 'comprova:scopes': ['validate:write', 'validate:read'] })
    expect(vc['comprova:legalBasis']).toBe('FRAUD_PREVENTION')
  })

  it('omite (em vez de fabricar) o que não existe no domínio', () => {
    const vc = credentialOf({
      issuer: { id: `${ISSUER_ORIGIN}/issuers/t`, authorization: null },
      claim: {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'address_exists',
        subject_type: 'person',
        target: { type: 'address', id: null, building_key: null },
      },
      result: {
        status: 'completed',
        verdict: 'NOT_FOUND',
        score: 0,
        confidence: 0.3,
        explanation: null,
      },
    })

    expect(vc['comprova:authorization']).toBeUndefined()
    expect(vc['comprova:result']['comprova:explanation']).toBeUndefined()
    expect(vc.credentialSubject['comprova:claim']['comprova:address']).toEqual({})
    expect(VerifiableCredentialSchema.safeParse(vc).success).toBe(true)
  })

  it('não reutiliza nomes de propriedades W3C para dados da Comprova', () => {
    const vc = credentialOf()
    const compprovaKeys = Object.keys(vc).filter((key) => key.startsWith('comprova:'))
    expect(compprovaKeys.length).toBeGreaterThan(0)
    // Toda chave Comprova é namespaced; `evidence` continua sendo o termo W3C.
    expect(Object.keys(vc)).toContain('evidence')
    expect(Object.keys(vc)).not.toContain('result')
    expect(Object.keys(vc)).not.toContain('policy')
  })

  it('exige `@context` como conjunto não vazio de URLs/objetos', () => {
    const vc = credentialOf()
    expect(VerifiableCredentialSchema.safeParse({ ...vc, '@context': [] }).success).toBe(false)
    expect(VerifiableCredentialSchema.safeParse({ ...vc, '@context': 'nope' }).success).toBe(false)
    // Contextos adicionais são permitidos pelo Data Model (a checagem do
    // contexto base é do verifier, §4.3).
    expect(
      VerifiableCredentialSchema.safeParse({
        ...vc,
        '@context': [...vc['@context'], 'https://example.org/extra-context'],
      }).success,
    ).toBe(true)

    // O documento securizado exige um proof Data Integrity bem formado.
    expect(SecuredVerifiableCredentialSchema.safeParse({ ...vc, proof: { proofValue: 'z1' } }).success).toBe(
      false,
    )
  })
})
