import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://app_user:app_user@localhost:5432/comprova',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_PEPPER: 'test-pepper',
  CREDENTIAL_ISSUER_ORIGIN: 'https://issuer.test',
  ...overrides,
})

describe('loadConfig — origem do issuer', () => {
  it('fora de produção aceita a origem reservada usada em dev/testes', () => {
    expect(loadConfig(baseEnv()).CREDENTIAL_ISSUER_ORIGIN).toBe('https://issuer.test')
    expect(
      loadConfig(baseEnv({ NODE_ENV: 'test', CREDENTIAL_ISSUER_ORIGIN: 'https://localhost:8443' }))
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
    ['TLD .test', 'https://issuer.test'],
    ['TLD .example', 'https://issuer.example'],
    ['TLD .invalid', 'https://issuer.invalid'],
    ['TLD .localhost', 'https://issuer.localhost'],
    ['TLD .local', 'https://issuer.local'],
    ['localhost', 'https://localhost'],
    ['loopback IPv4', 'https://127.0.0.1'],
    ['IPv6', 'https://[::1]'],
  ])('em produção recusa %s com mensagem clara', (_label, origin) => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: 'production', CREDENTIAL_ISSUER_ORIGIN: origin })),
    ).toThrow(/CREDENTIAL_ISSUER_ORIGIN: issuer origin must use a public DNS name in production/)
  })

  it('continua exigindo HTTPS em qualquer ambiente', () => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: 'production', CREDENTIAL_ISSUER_ORIGIN: 'http://issuer.comprova.dev' })),
    ).toThrow(/https/)
  })
})
