import { EVIDENCE_ARTIFACT_MAX_BYTES } from '@comprova/db'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app_user:app_user@localhost:5432/comprova',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_PEPPER: 'test-pepper',
  CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
  ...overrides,
})

describe('loadConfig — backend de assinatura', () => {
  it('default é local (KMS nunca vira default silenciosamente)', () => {
    expect(loadConfig(baseEnv()).SIGNING_KEY_PROVIDER).toBe('local')
  })

  it('aceita aws-kms e região explícita', () => {
    const config = loadConfig(baseEnv({ SIGNING_KEY_PROVIDER: 'aws-kms', AWS_KMS_REGION: 'sa-east-1' }))
    expect(config.SIGNING_KEY_PROVIDER).toBe('aws-kms')
    expect(config.AWS_KMS_REGION).toBe('sa-east-1')
  })

  it('recusa backend desconhecido', () => {
    expect(() => loadConfig(baseEnv({ SIGNING_KEY_PROVIDER: 'hsm' }))).toThrow(/SIGNING_KEY_PROVIDER/)
  })
})

describe('loadConfig — origem do issuer', () => {
  it('em desenvolvimento/teste aceita a origem reservada usada em dev/testes', () => {
    expect(loadConfig(baseEnv()).CREDENTIAL_ISSUER_ORIGIN).toBe('https://issuer.test')
    expect(
      loadConfig(baseEnv({ NODE_ENV: 'development', CREDENTIAL_ISSUER_ORIGIN: 'https://localhost:8443' }))
        .CREDENTIAL_ISSUER_ORIGIN,
    ).toBe('https://localhost:8443')
  })

  it('em produção aceita um domínio DNS público', () => {
    const config = loadConfig(
      baseEnv({ NODE_ENV: 'production', CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.comprova.dev' }),
    )
    expect(config.CREDENTIAL_ISSUER_ORIGIN).toBe('https://issuer.comprova.dev')
  })

  it.each([
    ['NODE_ENV ausente', undefined],
    ['prod', 'prod'],
    ['staging', 'staging'],
  ])('recusa a origem reservada com %s (fail-safe: só dev/test relaxam)', (_label, nodeEnv) => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: nodeEnv, CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test' })),
    ).toThrow(/CREDENTIAL_ISSUER_ORIGIN: issuer origin must use a public DNS name in production/)
  })

  it.each([
    ['TLD .test', 'https://issuer.test'],
    ['TLD .example', 'https://issuer.example'],
    ['TLD .invalid', 'https://issuer.invalid'],
    ['TLD .localhost', 'https://issuer.localhost'],
    ['TLD .local', 'https://issuer.local'],
    ['localhost', 'https://localhost'],
    ['loopback IPv4', 'https://127.0.0.1'],
    ['IPv6', 'https://[::1]'],
  ])('em produção recusa %s com mensagem clara', (_label, origin) => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: 'production', CREDENTIAL_ISSUER_ORIGIN: origin }))).toThrow(
      /CREDENTIAL_ISSUER_ORIGIN: issuer origin must use a public DNS name in production/,
    )
  })

  it('continua exigindo HTTPS em qualquer ambiente', () => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: 'production', CREDENTIAL_ISSUER_ORIGIN: 'http://issuer.comprova.dev' })),
    ).toThrow(/https/)
  })
})

describe('loadConfig — intake de comprovante', () => {
  it('aceita S3 opcional e limite abaixo do teto do artefato', () => {
    const config = loadConfig(
      baseEnv({
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'accessKey1',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_BUCKET: 'evidence',
        EVIDENCE_MAX_BYTES: '1024',
      }),
    )
    expect(config.S3_BUCKET).toBe('evidence')
    expect(config.EVIDENCE_MAX_BYTES).toBe(1024)
  })

  it('recusa limite acima do teto já imposto por evidence_artifact', () => {
    expect(() =>
      loadConfig(baseEnv({ EVIDENCE_MAX_BYTES: String(EVIDENCE_ARTIFACT_MAX_BYTES + 1) })),
    ).toThrow(/EVIDENCE_MAX_BYTES/)
  })

  it.each(['0', '-1', 'abc'])('recusa limite inválido %s', (value) => {
    expect(() => loadConfig(baseEnv({ EVIDENCE_MAX_BYTES: value }))).toThrow(/EVIDENCE_MAX_BYTES/)
  })
})
