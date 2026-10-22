import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request as httpsRequest, type Server } from 'node:https'
import type { AddressInfo, LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  classifyIpAddress,
  createSafeExternalFetch,
  isSafeExternalUrl,
  safeExternalFetch,
  SafeFetchError,
  type SafeFetch,
} from './safe-fetch.js'

const makeCertificate = (): { readonly dir: string; readonly key: Buffer; readonly cert: Buffer } => {
  const dir = mkdtempSync(join(tmpdir(), 'comprova-safe-fetch-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ])
  return { dir, key: readFileSync(keyPath), cert: readFileSync(certPath) }
}

describe('safe fetch', () => {
  let server: Server
  let port: number
  let certificate: { readonly dir: string; readonly key: Buffer; readonly cert: Buffer }

  beforeAll(async () => {
    certificate = makeCertificate()
    server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
      const path = request.url ?? '/'
      if (path === '/ok') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
        return
      }
      if (path === '/empty') {
        response.writeHead(200)
        response.end()
        return
      }
      if (path === '/no-content') {
        response.writeHead(204)
        response.end()
        return
      }
      if (path === '/missing-type') {
        response.writeHead(200)
        response.end('body without content-type')
        return
      }
      if (path === '/redirect-private') {
        response.writeHead(302, { location: 'http://127.0.0.1/secret' })
        response.end()
        return
      }
      if (path === '/redirect-http') {
        response.writeHead(302, { location: 'http://safe.test/next' })
        response.end()
        return
      }
      if (path === '/redirect-host') {
        response.writeHead(302, { location: 'https://other.test/next' })
        response.end()
        return
      }
      if (path === '/large') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('x'.repeat(2048))
        return
      }
      if (path === '/html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<html></html>')
        return
      }
      if (path === '/big-header') {
        response.writeHead(200, { 'content-type': 'application/json', 'x-big': 'a'.repeat(8_000) })
        response.end('{}')
        return
      }
      if (path === '/slow') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{}')
        }, 2_000)
        return
      }
      if (path === '/echo') {
        let body = ''
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ body, headers: request.headers, method: request.method }))
        })
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    rmSync(certificate.dir, { recursive: true, force: true })
  })

  const makeLocalSafeFetch = (resolveHost: () => Promise<readonly { address: string; family: 4 | 6 }[]>) =>
    createSafeExternalFetch({
      resolve: resolveHost,
      ca: certificate.cert,
      transport: (options) =>
        httpsRequest({
          ...options,
          hostname: '127.0.0.1',
          port,
          ca: certificate.cert,
          servername: 'localhost',
          lookup: undefined,
        }),
    })

  const makeGuard = (): SafeFetch => makeLocalSafeFetch(async () => [{ address: '8.8.8.8', family: 4 }])

  describe('classificação de IP', () => {
    it.each([
      ['127.0.0.1', 'LOOPBACK_IP'],
      ['::1', 'LOOPBACK_IP'],
      ['::ffff:127.0.0.1', 'LOOPBACK_IP'],
      ['10.0.0.1', 'PRIVATE_IP'],
      ['172.16.0.1', 'PRIVATE_IP'],
      ['192.168.1.1', 'PRIVATE_IP'],
      ['100.64.0.1', 'PRIVATE_IP'],
      ['fc00::1', 'PRIVATE_IP'],
      ['169.254.1.1', 'LINK_LOCAL_IP'],
      ['fe80::1', 'LINK_LOCAL_IP'],
      ['169.254.169.254', 'METADATA_IP'],
      ['fd00:ec2::254', 'METADATA_IP'],
      ['0.0.0.0', 'RESERVED_IP'],
      ['224.0.0.1', 'RESERVED_IP'],
      ['255.255.255.255', 'RESERVED_IP'],
      ['2001:db8::1', 'RESERVED_IP'],
    ] as const)('bloqueia %s como %s', (address, reason) => {
      expect(classifyIpAddress(address)).toBe(reason)
    })

    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permite unicast global %s', (address) => {
      expect(classifyIpAddress(address)).toBeNull()
    })
  })

  describe('sintaxe da URL', () => {
    it('aceita somente https público', () => {
      expect(isSafeExternalUrl('https://example.com/hook')).toBe(true)
      expect(isSafeExternalUrl('https://8.8.8.8/hook')).toBe(true)
    })

    it.each([
      'http://example.com/hook',
      'ftp://example.com/hook',
      'file:///etc/passwd',
      'data:text/plain,hello',
      'javascript:alert(1)',
      'not-a-url',
    ])('rejeita protocolo/URL inválida: %s', (url) => {
      expect(isSafeExternalUrl(url)).toBe(false)
    })

    it.each([
      'https://localhost/hook',
      'https://localhost./hook',
      'https://foo.localhost./hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/hook',
      'https://172.16.0.1/hook',
      'https://192.168.1.1/hook',
      'https://[::1]/hook',
      'https://[fe80::1]/hook',
      'https://[fc00::1]/hook',
      'https://user:pass@example.com/hook',
    ])('rejeita destino literal perigoso: %s', (url) => {
      expect(isSafeExternalUrl(url)).toBe(false)
    })
  })

  describe('DNS', () => {
    it('rejeita host público que resolve para IP privado', async () => {
      const guard = createSafeExternalFetch({
        resolve: async () => [{ address: '10.0.0.10', family: 4 }],
      })
      await expect(guard('https://public.example/hook')).rejects.toMatchObject({
        reason: 'PRIVATE_IP',
        hostname: 'public.example',
      })
    })

    it('rejeita quando qualquer IP da resposta é privado', async () => {
      const guard = createSafeExternalFetch({
        resolve: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '192.168.0.10', family: 4 },
        ],
      })
      await expect(guard('https://mixed.example/hook')).rejects.toMatchObject({ reason: 'PRIVATE_IP' })
    })

    it('rejeita resolução vazia ou com falha', async () => {
      const empty = createSafeExternalFetch({ resolve: async () => [] })
      await expect(empty('https://empty.example/hook')).rejects.toMatchObject({
        reason: 'HOST_RESOLUTION_FAILED',
      })

      const failing = createSafeExternalFetch({
        resolve: async () => {
          throw new Error('dns down')
        },
      })
      await expect(failing('https://dns-down.example/hook')).rejects.toMatchObject({
        reason: 'HOST_RESOLUTION_FAILED',
      })
    })

    it('não resolve DNS para IP literal perigoso', async () => {
      let called = false
      const guard = createSafeExternalFetch({
        resolve: async () => {
          called = true
          return [{ address: '8.8.8.8', family: 4 }]
        },
      })
      await expect(guard('https://127.0.0.1/hook')).rejects.toMatchObject({ reason: 'LOOPBACK_IP' })
      expect(called).toBe(false)
    })

    it('aplica timeout à resolução DNS', async () => {
      const guard = createSafeExternalFetch({
        resolve: () => new Promise<readonly { address: string; family: 4 | 6 }[]>(() => {}),
      })
      await expect(
        guard('https://slow-dns.example/hook', {
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ reason: 'TIMEOUT' })
    })

    it('fixa o IP validado e não faz segunda resolução (DNS rebinding)', async () => {
      let resolutions = 0
      let capturedLookup: LookupFunction | undefined
      const guard = createSafeExternalFetch({
        resolve: async () => {
          resolutions += 1
          // Uma segunda resolução devolveria loopback; a guarda não pode chamar.
          return resolutions === 1
            ? [{ address: '8.8.8.8', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }]
        },
        ca: certificate.cert,
        transport: (options) => {
          capturedLookup = options.lookup
          return httpsRequest({
            ...options,
            hostname: '127.0.0.1',
            port,
            ca: certificate.cert,
            servername: 'localhost',
            lookup: undefined,
          })
        },
      })

      const response = await guard('https://rebind.test/ok', { allowedContentTypes: ['application/json'] })
      expect(response.status).toBe(200)
      expect(resolutions).toBe(1)
      expect(capturedLookup).toBeTypeOf('function')

      const pinned = await new Promise<{ address: string; family: number | undefined }>((resolve, reject) => {
        capturedLookup?.('rebind.test', {}, (error, address, family) => {
          if (error !== null) {
            reject(error)
            return
          }
          if (typeof address !== 'string') {
            reject(new Error('lookup devolveu lista em vez de um endereço'))
            return
          }
          resolve({ address, family })
        })
      })
      expect(pinned).toEqual({ address: '8.8.8.8', family: 4 })

      // O Node 22 chama o lookup com `all: true` por causa do autoSelectFamily.
      const pinnedAll = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        capturedLookup?.('rebind.test', { all: true }, (error, addresses) => {
          if (error !== null) {
            reject(error)
            return
          }
          if (!Array.isArray(addresses)) {
            reject(new Error('lookup devolveu um endereço em vez de lista'))
            return
          }
          resolve(addresses)
        })
      })
      expect(pinnedAll).toEqual([{ address: '8.8.8.8', family: 4 }])
    })
  })

  describe('HTTP', () => {
    it('permite HTTPS e content-type esperado', async () => {
      const guard = makeGuard()
      const response = await guard('https://safe.test/ok', { allowedContentTypes: ['application/json'] })
      expect(response.status).toBe(200)
      expect(response.body.toString()).toBe('{"ok":true}')
      expect(response.address).toBe('8.8.8.8')
    })

    it.each(['/redirect-private', '/redirect-http', '/redirect-host'])(
      'não segue redirect em %s',
      async (path) => {
        const guard = makeGuard()
        await expect(guard(`https://safe.test${path}`)).rejects.toMatchObject({
          reason: 'REDIRECT_BLOCKED',
        })
      },
    )

    it('rejeita resposta acima do limite', async () => {
      const guard = makeGuard()
      await expect(
        guard('https://safe.test/large', {
          allowedContentTypes: ['application/json'],
          maxResponseBytes: 1_024,
        }),
      ).rejects.toMatchObject({ reason: 'RESPONSE_TOO_LARGE' })
    })

    it('rejeita content-type fora da allowlist', async () => {
      const guard = makeGuard()
      await expect(
        guard('https://safe.test/html', { allowedContentTypes: ['application/json'] }),
      ).rejects.toMatchObject({ reason: 'CONTENT_TYPE_NOT_ALLOWED' })
    })

    it('rejeita content-type ausente quando há corpo', async () => {
      const guard = makeGuard()
      await expect(
        guard('https://safe.test/missing-type', { allowedContentTypes: ['application/json'] }),
      ).rejects.toMatchObject({ reason: 'CONTENT_TYPE_NOT_ALLOWED' })
    })

    it('aceita resposta vazia sem content-type', async () => {
      const guard = makeGuard()
      const empty = await guard('https://safe.test/empty', { allowedContentTypes: ['application/json'] })
      expect(empty.status).toBe(200)
      expect(empty.body.byteLength).toBe(0)

      const noContent = await guard('https://safe.test/no-content', {
        allowedContentTypes: ['application/json'],
      })
      expect(noContent.status).toBe(204)
      expect(noContent.body.byteLength).toBe(0)
    })

    it('rejeita timeout', async () => {
      const guard = makeGuard()
      await expect(
        guard('https://safe.test/slow', {
          allowedContentTypes: ['application/json'],
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ reason: 'TIMEOUT' })
    })

    it('rejeita headers de resposta acima do limite', async () => {
      const guard = makeGuard()
      await expect(
        guard('https://safe.test/big-header', {
          allowedContentTypes: ['application/json'],
          maxHeaderBytes: 4_096,
        }),
      ).rejects.toMatchObject({ reason: 'HEADERS_TOO_LARGE' })
    })

    it('envia POST com corpo, assinatura e content-length', async () => {
      const guard = makeGuard()
      const response = await guard('https://safe.test/echo', {
        method: 'POST',
        headers: { 'x-signature': 'abc' },
        body: 'hello',
        allowedContentTypes: ['application/json'],
      })
      const echoed = JSON.parse(response.body.toString()) as {
        body: string
        headers: Record<string, string>
        method: string
      }
      expect(echoed.body).toBe('hello')
      expect(echoed.headers['x-signature']).toBe('abc')
      expect(echoed.headers['content-length']).toBe('5')
      expect(echoed.method).toBe('POST')
    })

    it('rejeita headers proibidos, corpo em GET e corpo grande demais', async () => {
      const guard = makeGuard()
      await expect(
        guard('https://safe.test/ok', { headers: { Host: 'evil.example' } }),
      ).rejects.toMatchObject({ reason: 'INVALID_REQUEST' })
      await expect(
        guard('https://safe.test/ok', { method: 'GET', body: 'not allowed' }),
      ).rejects.toMatchObject({ reason: 'INVALID_REQUEST' })
      await expect(
        guard('https://safe.test/ok', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }),
      ).rejects.toMatchObject({ reason: 'INVALID_REQUEST' })
    })

    it('rejeita protocolo não-HTTPS e IP literal privado sem rede', async () => {
      await expect(safeExternalFetch('http://example.com/hook')).rejects.toMatchObject({
        reason: 'INVALID_PROTOCOL',
      })
      await expect(safeExternalFetch('https://127.0.0.1/hook')).rejects.toMatchObject({
        reason: 'LOOPBACK_IP',
      })
    })

    it('expõe motivo estruturado em SafeFetchError', async () => {
      const guard = makeGuard()
      const error = await guard('https://safe.test/html', {
        allowedContentTypes: ['application/json'],
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect((error as SafeFetchError).reason).toBe('CONTENT_TYPE_NOT_ALLOWED')
      expect((error as SafeFetchError).status).toBe(200)
    })
  })
})
