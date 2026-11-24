import { describe, expect, it, vi } from 'vitest'

import { makeSupabaseObjectStore } from './index.js'

const makeSupabaseClientMock = () => {
  const upload = vi.fn()
  const download = vi.fn()
  const remove = vi.fn()
  const storage = {
    from: vi.fn(() => ({
      upload,
      download,
      remove,
    })),
    // Atalho para testes: acesso direto aos mocks sem passar por .from()
    upload,
    download,
    remove,
  }
  const createClient = vi.fn(() => ({
    storage,
  }))
  return { createClient, storage, upload, download, remove }
}

type SupabaseClientMock = ReturnType<typeof makeSupabaseClientMock>
/** O adaptador recebe a função `createClient`; nos testes, o Mock que a substitui. */
type CreateClientMock = SupabaseClientMock['createClient']

const makeStore = (createClientMock: CreateClientMock = makeSupabaseClientMock().createClient) =>
  makeSupabaseObjectStore(
    {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      bucket: 'evidence',
    },
    createClientMock,
  )

describe('makeSupabaseObjectStore', () => {
  it('faz upload bem-sucedido e retorna metadados', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.upload.mockResolvedValue({ error: null })

    const stored = await makeStore(createClient).put(
      'tenants/abc123/evidence/artifact-1',
      new Uint8Array([1, 2, 3]),
      'application/pdf',
    )

    expect(createClient).toHaveBeenCalledWith('https://test.supabase.co', 'service-role-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    expect(storage.upload).toHaveBeenCalledWith(
      'tenants/abc123/evidence/artifact-1',
      new Uint8Array([1, 2, 3]),
      { contentType: 'application/pdf', upsert: false },
    )
    expect(stored).toMatchObject({
      key: 'tenants/abc123/evidence/artifact-1',
      bytes: 3,
      sha256: expect.any(Uint8Array),
    })
    expect(stored.uri).toContain('https://test.supabase.co/storage/v1/object/public/evidence/')
  })

  it('faz download bem-sucedido', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.download.mockResolvedValue({
      data: new Blob([new Uint8Array([1, 2, 3])]),
      error: null,
    })

    const data = await makeStore(createClient).get('tenants/abc123/evidence/artifact-1')

    expect(storage.download).toHaveBeenCalledWith('tenants/abc123/evidence/artifact-1')
    expect(data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('retorna null quando o objeto não existe (404)', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.download.mockResolvedValue({
      data: null,
      error: { statusCode: 404, message: 'Not found' },
    })

    const data = await makeStore(createClient).get('tenants/abc123/evidence/nao-existe')

    expect(data).toBeNull()
  })

  it('faz exclusão bem-sucedida', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.remove.mockResolvedValue({ error: null })

    await makeStore(createClient).delete('tenants/abc123/evidence/artifact-1')

    expect(storage.remove).toHaveBeenCalledWith(['tenants/abc123/evidence/artifact-1'])
  })

  it('lança erro quando o upload falha', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.upload.mockResolvedValue({ error: { message: 'Storage error' } })

    await expect(
      makeStore(createClient).put(
        'tenants/abc123/evidence/artifact-1',
        new Uint8Array([1]),
        'application/pdf',
      ),
    ).rejects.toThrow('Storage error')
  })

  it('lança erro quando o download falha com erro que não é 404', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.download.mockResolvedValue({
      data: null,
      error: { statusCode: 500, message: 'Server error' },
    })

    await expect(makeStore(createClient).get('tenants/abc123/evidence/artifact-1')).rejects.toThrow(
      'Server error',
    )
  })

  it('é idempotente: upload da mesma chave duas vezes substitui', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.upload.mockResolvedValue({ error: null })

    const store = makeStore(createClient)
    await store.put('tenants/abc123/evidence/artifact-1', new Uint8Array([1]), 'application/pdf')
    await store.put('tenants/abc123/evidence/artifact-1', new Uint8Array([2]), 'application/pdf')

    expect(storage.upload).toHaveBeenCalledTimes(2)
  })

  it('não loga credenciais nem conteúdo do documento', async () => {
    const { createClient, storage } = makeSupabaseClientMock()
    storage.upload.mockResolvedValue({ error: null })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await makeStore(createClient).put(
      'tenants/abc123/evidence/artifact-1',
      new Uint8Array([1, 2, 3]),
      'application/pdf',
    )

    const logOutput = logSpy.mock.calls.map((args) => args.join(' ')).join(' ')
    const errorOutput = errorSpy.mock.calls.map((args) => args.join(' ')).join(' ')

    expect(logOutput).not.toContain('service-role-key')
    expect(logOutput).not.toContain('supabaseUrl')
    expect(errorOutput).not.toContain('service-role-key')
    expect(logOutput).not.toContain('1,2,3')
    expect(errorOutput).not.toContain('1,2,3')

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
