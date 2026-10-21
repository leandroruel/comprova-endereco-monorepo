import { evidenceSetHashOfObservations } from '@comprova/core'
import { describe, expect, it } from 'vitest'
import type { AssertionObservation, AssertionSource } from '../schema/assertion.schema.js'
import { buildCredential } from './credential.service.js'
import { issuerIdOf, verificationMethodOf, localIssuer } from './issuer.service.js'
import type { IssuerIdentity } from '../schema/issuer.schema.js'
import { ASSERTION_METHOD } from '../schema/proof.schema.js'
import { CREDENTIAL_STATUS_TYPE } from '../schema/status.schema.js'
import { generateEd25519KeyPair, makeEd25519Signer } from './signer.service.js'
import { credentialIdOf, credentialStatusUrlOf } from './status.service.js'
import { VC_CONTEXT_URL, type SecuredVerifiableCredential } from '../schema/credential.schema.js'
import { createDataIntegrityProof } from './proof.service.js'
import { verifyCredentialIntegrity } from './verification.service.js'

const ISSUER_ORIGIN = 'https://issuer.test'
const TENANT = '11111111-1111-4111-8111-111111111111'
const VALIDATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLAIM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ADDRESS_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** Instante de assinatura injetado: mantém as provas determinísticas no teste. */
const PROOF_CREATED_AT = new Date('2026-02-01T00:00:00.000Z')

const observation = (
  overrides: Partial<AssertionObservation> & { readonly id: string },
): AssertionObservation => ({
  checker: 'registry_match',
  checkerVersion: '1',
  stance: 'supports',
  strength: 0.9,
  confidence: 0.8,
  source: 'receita',
  observedAt: new Date('2026-01-02T03:04:05.000Z'),
  ttlSeconds: 30 * 24 * 60 * 60,
  evidenceSha256: null,
  detail: { nested: { b: 2, a: 1 } },
  ...overrides,
})

const source = (
  observations: AssertionObservation[],
  validationOverrides: Partial<AssertionSource['validation']> = {},
): AssertionSource => ({
  tenantId: TENANT,
  validation: {
    id: VALIDATION_ID,
    verdict: 'CONFIRMED_COMMERCIAL',
    score: 0.9,
    confidence: 0.8,
    policyVersion: '2026.13.1',
    policyHash: 'd'.repeat(64),
    scorerVersion: '1',
    evidenceSetHash: evidenceSetHashOfObservations(observations),
    legalBasis: 'FRAUD_PREVENTION',
    issuerScopes: ['validate:write'],
    explanation: {
      code: 'ADDRESS_CONFIRMED',
      summary: 'ok',
      supporting_evidence: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
      contradicting_evidence: [],
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:01.000Z'),
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
    ...validationOverrides,
  },
  subject: { docType: 'CNPJ', docHmac: Buffer.alloc(32, 7) },
  claim: {
    id: CLAIM_ID,
    type: 'business_registered_address',
    subjectType: 'organization',
    targetType: 'address',
    addressId: ADDRESS_ID,
  },
  addressBuildingKey: 'b64:AAAA',
  observations,
})

const keyPair = generateEd25519KeyPair()
const issuer: IssuerIdentity = localIssuer(ISSUER_ORIGIN, TENANT, 'key-1')
const signer = makeEd25519Signer(keyPair.privateKey)
/** Método confiável que o consumidor declara conhecer (chave + identidade). */
const trusted = { id: verificationMethodOf(issuer), publicKey: keyPair.publicKey }

const twoObservations = (): AssertionObservation[] => [
  observation({
    id: '00000000-0000-4000-8000-000000000002',
    stance: 'contradicts',
    evidenceSha256: Buffer.alloc(32, 9),
  }),
  observation({ id: '00000000-0000-4000-8000-000000000001' }),
]

const emit = async (observations = twoObservations()): Promise<SecuredVerifiableCredential> =>
  buildCredential(source(observations), { issuer, signer, now: () => PROOF_CREATED_AT })

const transport = (credential: SecuredVerifiableCredential): SecuredVerifiableCredential =>
  JSON.parse(JSON.stringify(credential)) as SecuredVerifiableCredential

/** Inverte recursivamente a ordem das chaves (a ordem de arrays é preservada). */
const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    )
  }
  return value
}

describe('buildCredential + verifyCredentialIntegrity', () => {
  it('emite uma VC 2.0 que espelha a assertion', async () => {
    const credential = await emit()

    expect(credential['@context'][0]).toBe(VC_CONTEXT_URL)
    expect(credential.type).toEqual(['VerifiableCredential', 'comprova:AddressCredential'])
    expect(credential.issuer).toBe(issuerIdOf(ISSUER_ORIGIN, TENANT))
    expect(credential.issuer).toMatch(/^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}$/)
    const credentialId = credentialIdOf(issuer.id, VALIDATION_ID)
    expect(credential.id).toBe(`${issuer.id}/credentials/${credentialId}`)
    expect(credential.credentialStatus).toEqual({
      id: credentialStatusUrlOf(issuer.id, credentialId),
      type: CREDENTIAL_STATUS_TYPE,
    })
    // `validFrom` é o início da validade do veredito: a conclusão da validation.
    expect(credential.validFrom).toBe('2026-01-01T00:00:01.000Z')
    expect(credential.validUntil).toBe('2026-01-31T00:00:00.000Z')
    expect(credential.credentialSubject.id).toMatch(
      /^https:\/\/issuer\.test\/issuers\/[A-Za-z0-9_-]{43}\/subjects\/[0-9a-f]{64}$/,
    )
    expect(credential.credentialSubject['comprova:docType']).toBe('CNPJ')
    expect(credential.credentialSubject['comprova:claim'].id).toBe(`urn:uuid:${CLAIM_ID}`)
    expect(credential.credentialSubject['comprova:claim']['comprova:address']).toEqual({
      id: `urn:uuid:${ADDRESS_ID}`,
      'comprova:buildingKey': 'b64:AAAA',
    })
    expect(credential.evidence).toHaveLength(2)
    expect(credential['comprova:evidenceSetHash']).toMatch(/^[0-9a-f]{64}$/)
    expect(credential['comprova:result']['comprova:verdict']).toBe('CONFIRMED_COMMERCIAL')
    expect(credential['comprova:policy']).toEqual({
      'comprova:version': '2026.13.1',
      'comprova:hash': 'd'.repeat(64),
    })
    expect(credential['comprova:algorithm']).toEqual({ 'comprova:scorerVersion': '1' })
    expect(credential['comprova:authorization']).toEqual({ 'comprova:scopes': ['validate:write'] })
    expect(credential.proof.type).toBe('DataIntegrityProof')
    expect(credential.proof.cryptosuite).toBe('eddsa-jcs-2022')
    expect(credential.proof.proofPurpose).toBe('assertionMethod')
    expect(credential.proof.verificationMethod).toBe(verificationMethodOf(issuer))
    expect(credential.proof.verificationMethod).toBe(`${issuer.id}#key-1`)
    expect(credential.proof.created).toBe(PROOF_CREATED_AT.toISOString())
    expect(credential.proof.proofValue).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/)
  })

  it('é verificável por um processo independente que só recebe a credencial, a chave pública e o método confiável', async () => {
    const credential = transport(await emit())
    expect(
      verifyCredentialIntegrity(credential, {
        trusted,
        expectedIssuerId: issuer.id,
      }),
    ).toMatchObject({ valid: true })
  })

  it('é autocontida: o JSON transportado verifica sem nenhum dado além da chave confiável', async () => {
    const credential = transport(await emit())

    // Nenhuma dependência de PostgreSQL/Redis/Temporal/S3/API: o verificador só
    // recebe o documento, a chave pública e o id do método em que se confia.
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({ valid: true })

    const json = JSON.stringify(credential)
    for (const internal of [
      'validation_id',
      'validationId',
      'evidence_id',
      's3_uri',
      'doc_hmac',
      'doc_enc',
    ]) {
      expect(json).not.toContain(internal)
    }
  })

  it('não assina o ponteiro material: um `evidence_id` distinto produz a mesma prova', async () => {
    const withoutPointer = await emit()
    const withPointer: AssertionObservation[] = twoObservations().map((observation, index) => ({
      ...observation,
      evidenceId: `s3-${index}`,
    }))
    const other = await buildCredential(source(withPointer), { issuer, signer, now: () => PROOF_CREATED_AT })

    expect(other.id).toBe(withoutPointer.id)
    expect(other.credentialStatus).toEqual(withoutPointer.credentialStatus)
    expect(other.proof.proofValue).toBe(withoutPointer.proof.proofValue)
  })

  it('é determinística: a ordem das observações vinda do banco não muda os bytes assinados', async () => {
    const forward = await emit(twoObservations())
    const backward = await emit([...twoObservations()].reverse())
    expect(backward.proof.proofValue).toBe(forward.proof.proofValue)
  })

  it('é determinística: a ordem das propriedades JSON não muda o material assinado nem a verificação', async () => {
    const credential = await emit()

    // Reordenar recursivamente as chaves de todo o documento não pode mudar o
    // proof (JCS ordena as propriedades) nem invalidar a verificação.
    const reversed = reverseKeys(credential) as SecuredVerifiableCredential
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(credential))
    expect(
      verifyCredentialIntegrity(reversed, {
        trusted,
      }),
    ).toMatchObject({ valid: true })
  })

  it('preserva evidence_sha256 sem depender de evidence_id', async () => {
    const credential = await emit()
    const linked = credential.evidence.find((e) => e.id === 'urn:uuid:00000000-0000-4000-8000-000000000002')
    expect(linked?.['comprova:evidenceSha256']).toBe(Buffer.alloc(32, 9).toString('hex'))
    expect(JSON.stringify(credential)).not.toContain('evidence_id')
    expect(JSON.stringify(credential)).not.toContain('s3_uri')
  })

  it('recusa emitir quando o resultado não está final ou faltam bindings', async () => {
    await expect(
      buildCredential(source(twoObservations(), { verdict: null }), { issuer, signer }),
    ).rejects.toThrow(/incomplete/)
    await expect(
      buildCredential(source(twoObservations(), { evidenceSetHash: null }), { issuer, signer }),
    ).rejects.toThrow(/bindings/)
    await expect(
      buildCredential(source(twoObservations(), { evidenceSetHash: 'f'.repeat(64) }), { issuer, signer }),
    ).rejects.toThrow(/mismatch/)
  })
})

describe('tempo: `proof.created` e `validFrom`', () => {
  const issuance = new Date('2026-02-01T00:00:00.000Z')
  const clock = (): Date => issuance

  it('marca a prova com o instante real da emissão, nunca com um timestamp da validation', async () => {
    const credential = await buildCredential(source(twoObservations()), { issuer, signer, now: clock })

    // validation.created_at = 2026-01-01T00:00:00Z; completed_at = +1s.
    expect(credential.proof.created).toBe(issuance.toISOString())
    expect(credential.proof.created).not.toBe(credential.validFrom)
    expect(credential.proof.created).not.toBe(credential['comprova:result']['comprova:completedAt'])
  })

  it('sem relógio injetado, `proof.created` é o relógio do sistema (a prova é criada agora)', async () => {
    const credential = await buildCredential(source(twoObservations()), { issuer, signer })
    const created = Date.parse(credential.proof.created ?? '')

    expect(Number.isFinite(created)).toBe(true)
    expect(Math.abs(created - Date.now())).toBeLessThan(60_000)
    // Nenhum timestamp histórico da validation vira instante de assinatura.
    expect(credential.proof.created).not.toBe(credential.validFrom)
    expect(credential.proof.created).not.toBe(credential['comprova:result']['comprova:completedAt'])
  })

  it('`validFrom` é a conclusão da validation (o veredito só existe a partir dela)', async () => {
    const credential = await buildCredential(source(twoObservations()), { issuer, signer, now: clock })

    expect(credential.proof.created).not.toBe('2026-01-01T00:00:01.000Z')
    expect(credential.validFrom).toBe('2026-01-01T00:00:01.000Z')
    expect(credential.validFrom).not.toBe('2026-01-01T00:00:00.000Z')
    expect(credential['comprova:result']['comprova:completedAt']).toBe('2026-01-01T00:00:01.000Z')
  })

  it('recusa emitir sem instante de conclusão (não presume `created_at` como `validFrom`)', async () => {
    // Validação terminal sem `completed_at` (registro anterior ao preenchimento
    // do campo): a conclusão real é desconhecida, então não há `validFrom`
    // honesto a declarar — nem `created_at` (início da requisição) nem a
    // emissão servem.
    await expect(
      buildCredential(source(twoObservations(), { completedAt: null }), { issuer, signer, now: clock }),
    ).rejects.toThrow(/completed_at/)
  })

  it('usa `validUntil` da credencial, não `expires_at` de retenção', async () => {
    const validUntil = new Date('2026-01-15T00:00:00.000Z')
    const credential = await buildCredential(source(twoObservations(), { validUntil }), {
      issuer,
      signer,
      now: clock,
    })
    expect(credential.validUntil).toBe(validUntil.toISOString())
    expect(credential.validUntil).not.toBe(source(twoObservations()).validation.expiresAt.toISOString())
  })

  it('exige janela NÃO vazia: `completed_at < validUntil` (nunca janela invertida ou de duração zero)', async () => {
    const expiresAt = new Date('2026-01-31T00:00:00.000Z')
    const at = (completedAt: Date): Promise<SecuredVerifiableCredential> =>
      buildCredential(source(twoObservations(), { completedAt }), { issuer, signer, now: clock })

    // Janela de duração zero (`validFrom == validUntil`).
    await expect(at(expiresAt)).rejects.toThrow(/window/)

    // Janela invertida (`validFrom > validUntil`): a validação concluiu depois
    // do horizonte da credencial (aqui, fallback de `expiresAt`).
    await expect(at(new Date(expiresAt.getTime() + 1))).rejects.toThrow(/window/)

    // 1 ms antes do horizonte ainda é uma janela válida.
    const lastInstant = new Date(expiresAt.getTime() - 1)
    const credential = await at(lastInstant)
    expect(credential.validFrom).toBe(lastInstant.toISOString())
    expect(credential.validUntil).toBe(expiresAt.toISOString())
    expect(Date.parse(credential.validFrom)).toBeLessThan(Date.parse(credential.validUntil!))
  })

  it('reemitir a mesma validation produz uma NOVA prova sobre o MESMO documento', async () => {
    const first = await emit()
    const second = await buildCredential(source(twoObservations()), {
      issuer,
      signer,
      now: () => new Date('2026-02-02T00:00:00.000Z'),
    })
    const { proof: firstProof, ...firstDocument } = first
    const { proof: secondProof, ...secondDocument } = second

    // O documento (sem proof) é função da assertion; a prova carrega o instante
    // real de cada assinatura. Reproduzir bytes do proof exigiria reaproveitar o
    // `created` da primeira emissão de forma explícita (`now`).
    expect(firstDocument).toEqual(secondDocument)
    expect(firstProof.created).not.toBe(secondProof.created)
    expect(firstProof.proofValue).not.toBe(secondProof.proofValue)
  })
})

describe('adulteração da credencial', () => {
  const valid = async (): Promise<SecuredVerifiableCredential> => transport(await emit())

  const expectInvalid = async (mutate: (credential: SecuredVerifiableCredential) => void): Promise<void> => {
    const credential = await valid()
    mutate(credential)
    expect(verifyCredentialIntegrity(credential, { trusted }).valid).toBe(false)
  }

  it('detecta alteração em issuer, subject, claim e endereço', async () => {
    await expectInvalid((c) => {
      c.issuer = 'https://issuer.test/issuers/outro-issuer'
    })
    await expectInvalid((c) => {
      c.credentialSubject.id = `${issuer.id}/subjects/${'f'.repeat(64)}`
    })
    await expectInvalid((c) => {
      c.credentialSubject['comprova:claim']['comprova:claimType'] = 'address_exists'
    })
    await expectInvalid((c) => {
      ;(c.credentialSubject['comprova:claim'] as Record<string, unknown>)['comprova:targetType'] = 'parcel'
    })
    await expectInvalid((c) => {
      c.credentialSubject['comprova:claim']['comprova:address'].id =
        'urn:uuid:99999999-9999-4999-8999-999999999999'
    })
    await expectInvalid((c) => {
      c.credentialSubject['comprova:claim']['comprova:address']['comprova:buildingKey'] = 'b64:BBBB'
    })
  })

  it('detecta alteração no resultado', async () => {
    await expectInvalid((c) => {
      c['comprova:result']['comprova:verdict'] = 'NOT_FOUND'
    })
    await expectInvalid((c) => {
      c['comprova:result']['comprova:score'] = 0.1
    })
    await expectInvalid((c) => {
      c['comprova:result']['comprova:confidence'] = 0.1
    })
    await expectInvalid((c) => {
      delete c['comprova:result']['comprova:explanation']
    })
  })

  it('detecta alteração nos bindings de policy, algoritmo e evidência', async () => {
    await expectInvalid((c) => {
      c['comprova:policy']['comprova:hash'] = 'a'.repeat(64)
    })
    await expectInvalid((c) => {
      c['comprova:policy']['comprova:version'] = '2026.99.9'
    })
    await expectInvalid((c) => {
      c['comprova:algorithm']['comprova:scorerVersion'] = '2'
    })
    await expectInvalid((c) => {
      c['comprova:evidenceSetHash'] = 'b'.repeat(64)
    })
  })

  it('detecta adulteração do `id` e do ponteiro de status como INVALID_SIGNATURE', async () => {
    const cases: ReadonlyArray<(credential: SecuredVerifiableCredential) => void> = [
      (c) => {
        c.id = `${issuer.id}/credentials/${'f'.repeat(43)}`
      },
      (c) => {
        c.credentialStatus!.id = `${issuer.id}/credentials/${'f'.repeat(43)}/status`
      },
    ]
    for (const mutate of cases) {
      const credential = await valid()
      mutate(credential)
      expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
        valid: false,
        reason: 'INVALID_SIGNATURE',
      })
    }

    // O `type` é parte do schema: um tipo de status não suportado é recusado
    // estruturalmente, antes mesmo da prova.
    const credential = await valid()
    ;(credential.credentialStatus as { type: string }).type = 'StatusList2021Entry'
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })
  })

  it('recusa um binding de status incoerente mesmo quando a prova foi refeita sobre ele', async () => {
    // Mesmo assinado, `credentialStatus.id` tem de ser exatamente `<id>/status`.
    // Sem essa checagem estrutural, um issuer (ou quem controlasse a chave)
    // poderia apontar a credencial para o status de OUTRA credencial/tenant.
    const credential = await valid()
    const { proof, ...document } = credential
    const mismatched: Record<string, unknown> = {
      ...document,
      credentialStatus: {
        id: `${String(document.id)}/outro`,
        type: CREDENTIAL_STATUS_TYPE,
      },
    }
    const resigned = {
      ...mismatched,
      proof: await createDataIntegrityProof(mismatched, {
        verificationMethod: proof.verificationMethod,
        proofPurpose: ASSERTION_METHOD,
        created: PROOF_CREATED_AT.toISOString(),
        signer,
      }),
    } as SecuredVerifiableCredential

    expect(verifyCredentialIntegrity(resigned, { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    // E o `id` fora do issuer também é recusado estruturalmente.
    const foreignId = {
      ...document,
      id: `https://other.test/issuers/${'a'.repeat(43)}/credentials/${'b'.repeat(43)}`,
    }
    const resignedForeign = {
      ...foreignId,
      proof: await createDataIntegrityProof(foreignId, {
        verificationMethod: proof.verificationMethod,
        proofPurpose: ASSERTION_METHOD,
        created: PROOF_CREATED_AT.toISOString(),
        signer,
      }),
    } as SecuredVerifiableCredential
    expect(verifyCredentialIntegrity(resignedForeign, { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })
  })

  it('detecta alteração na janela de validade, no digest e no detalhe da evidência', async () => {
    await expectInvalid((c) => {
      c.validFrom = '2000-01-01T00:00:00.000Z'
    })
    await expectInvalid((c) => {
      c['comprova:result']['comprova:completedAt'] = '2000-01-01T00:00:00.000Z'
    })
    await expectInvalid((c) => {
      c.evidence[0]!['comprova:evidenceSha256'] = 'a'.repeat(64)
    })
    await expectInvalid((c) => {
      c.evidence[0]!['comprova:detail'] = { nested: { a: 1, b: 3 } }
    })
    await expectInvalid((c) => {
      c.proof.proofValue = c.proof.proofValue.slice(0, -1) + (c.proof.proofValue.endsWith('A') ? 'B' : 'A')
    })
  })

  it('classifica falhas estruturais, de contexto, issuer e chave', async () => {
    expect(verifyCredentialIntegrity({}, { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })
    expect(verifyCredentialIntegrity([], { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    const credential = await valid()
    expect(
      verifyCredentialIntegrity({ ...credential, '@context': ['https://example.org'] }, { trusted }),
    ).toMatchObject({
      valid: false,
      reason: 'UNSUPPORTED_CREDENTIAL',
    })

    expect(verifyCredentialIntegrity(credential, { trusted, expectedIssuerId: 'x' })).toMatchObject({
      valid: false,
      reason: 'ISSUER_MISMATCH',
    })
    expect(
      verifyCredentialIntegrity(credential, {
        expectedIssuerId: issuer.id,
        trusted: { id: `${issuer.id}#outra-chave`, publicKey: keyPair.publicKey },
      }),
    ).toMatchObject({ valid: false, reason: 'VERIFICATION_METHOD_MISMATCH' })

    const otherKey = generateEd25519KeyPair()
    expect(
      verifyCredentialIntegrity(credential, { trusted: { ...trusted, publicKey: otherKey.publicKey } }),
    ).toMatchObject({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })
  })

  it('amarra o `verificationMethod` ao issuer declarado (§5.9)', async () => {
    // Sem resolução de chave, o binding é estrutural: um proof válido de outro
    // issuer (ou o próprio issuer com o método alterado) não pode se declarar
    // emitido por este issuer.
    const credential = await valid()
    credential.proof.verificationMethod = 'https://issuer.test/issuers/outro-issuer#key-1'
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })

    const noFragment = await valid()
    noFragment.proof.verificationMethod = `${issuer.id}#`
    expect(verifyCredentialIntegrity(noFragment, { trusted })).toMatchObject({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
  })

  it('exige que o `verificationMethod` seja exatamente o método confiável', async () => {
    // A MESMA chave pública assina os dois métodos (`#key-1` e `#key-2`), então a
    // assinatura é válida para a chave fornecida nos dois casos. Só o vínculo
    // explícito entre a chave confiável e o id do método distingue os dois: sem
    // ele, a credencial escolheria em qual método o consumidor estaria confiando.
    const keyId = 'key-2'
    const otherIssuer = localIssuer(ISSUER_ORIGIN, TENANT, keyId)
    const credential = transport(
      await buildCredential(source(twoObservations()), {
        issuer: otherIssuer,
        signer,
        now: () => PROOF_CREATED_AT,
      }),
    )

    expect(credential.proof.verificationMethod).toBe(verificationMethodOf(otherIssuer))
    expect(
      verifyCredentialIntegrity(credential, {
        trusted: { id: verificationMethodOf(otherIssuer), publicKey: keyPair.publicKey },
      }),
    ).toMatchObject({ valid: true })
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
      valid: false,
      reason: 'VERIFICATION_METHOD_MISMATCH',
    })
  })

  it('exige `proofPurpose: assertionMethod` (uma prova para outro motivo não vale como credencial)', async () => {
    const credential = await valid()
    credential.proof.proofPurpose = 'authentication'
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
      valid: false,
      reason: 'PROOF_PURPOSE_MISMATCH',
    })
  })

  it('recusa janela invertida e aceita `validFrom == validUntil` (VC 2.0 §4.9)', async () => {
    const credential = await valid()
    const validUntil = credential.validUntil!

    // A checagem da janela vem ANTES da assinatura: um documento com bytes
    // coerentes, mas janela invertida, é recusado pela janela — a proteção não
    // depende de a assinatura quebrar.
    expect(
      verifyCredentialIntegrity(
        { ...credential, validFrom: new Date(Date.parse(validUntil) + 1).toISOString() },
        { trusted },
      ),
    ).toMatchObject({ valid: false, reason: 'INVALID_TIMESTAMP' })

    // Igualdade é permitida pela especificação. Mutar sem reassinar cai na
    // assinatura (a janela já passou); reassinado, o documento é aceito.
    const equalWindow = await valid()
    equalWindow.validFrom = equalWindow.validUntil!
    expect(verifyCredentialIntegrity(equalWindow, { trusted })).toMatchObject({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    })

    const proof = equalWindow.proof
    const unsecured = { ...equalWindow } as Record<string, unknown>
    delete unsecured['proof']
    equalWindow.proof = await createDataIntegrityProof(unsecured, {
      verificationMethod: proof.verificationMethod,
      proofPurpose: ASSERTION_METHOD,
      created: PROOF_CREATED_AT.toISOString(),
      signer,
    })
    expect(verifyCredentialIntegrity(equalWindow, { trusted })).toMatchObject({
      valid: true,
    })
  })

  it('detecta incoerência entre o conjunto de evidências e o evidence_set_hash', async () => {
    const credential = await valid()
    // Adultera o conjunto E re-sela o hash: a assinatura continua cobrindo os
    // dois, então a falha aparece como assinatura inválida — o binding é o que
    // garante a amarração.
    credential.evidence = credential.evidence.slice(0, 1)
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
      valid: false,
      reason: 'EVIDENCE_SET_MISMATCH',
    })
  })

  it('recusa documentos sem os membros obrigatórios da VC', async () => {
    const credential = await valid()

    for (const member of ['@context', 'type', 'issuer', 'credentialSubject', 'proof'] as const) {
      const incomplete = { ...credential } as Record<string, unknown>
      delete incomplete[member]
      expect(verifyCredentialIntegrity(incomplete, { trusted }), member).toMatchObject({
        valid: false,
        reason: 'MALFORMED_CREDENTIAL',
      })
    }
  })

  it('recusa cryptosuite inesperada e proof sem os campos exigidos', async () => {
    const credential = await valid()
    credential.proof.cryptosuite = 'eddsa-rdfc-2022'
    expect(verifyCredentialIntegrity(credential, { trusted })).toMatchObject({
      valid: false,
      reason: 'UNSUPPORTED_CRYPTOSUITE',
    })

    const noPurpose = await valid()
    ;(noPurpose.proof as Record<string, unknown>).proofPurpose = undefined
    expect(verifyCredentialIntegrity(noPurpose, { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })

    const noMethod = await valid()
    ;(noMethod.proof as Record<string, unknown>).verificationMethod = undefined
    expect(verifyCredentialIntegrity(noMethod, { trusted })).toMatchObject({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    })
  })
})
