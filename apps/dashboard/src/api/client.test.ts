import { afterEach, describe, expect, it, vi } from 'vitest'
import { createValidation, getAddressByCep, type AddressInput } from './client'

/**
 * Payload do `POST /v1/validations` montado pelo dashboard.
 *
 * A regra de `ADDRESS_REQUIRED_FOR_CPF` continua no backend; aqui só provamos
 * que o cliente envia `address` exatamente para o caso em que ele é exigido
 * (CPF com endereço informado) e não altera o comportamento de CNPJ.
 */

const ok = (): Response =>
  new Response(JSON.stringify({ validation_id: 'stub' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const bodyOf = (call: unknown): Record<string, unknown> => {
  const init = (call as [string, RequestInit] | undefined)?.[1]
  if (init?.body === undefined) throw new Error('request body missing')
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

const address: AddressInput = {
  logradouro: 'Rua das Flores',
  numero: '100',
  bairro: 'Centro',
  municipio: 'São Paulo',
  uf: 'SP',
  cep: '01310-100',
}

describe('createValidation — payload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('envia address quando o documento é um CPF', async () => {
    const fetchSpy = vi.fn(async () => ok())
    vi.stubGlobal('fetch', fetchSpy)

    await createValidation('529.982.247-25', 'fast', address)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.document).toEqual({ type: 'CPF', value: '529.982.247-25' })
    expect(body.address).toEqual({ ...address, country_code: 'BR' })
  })

  it('não envia address quando o CPF não recebe endereço', async () => {
    const fetchSpy = vi.fn(async () => ok())
    vi.stubGlobal('fetch', fetchSpy)

    await createValidation('529.982.247-25', 'fast')

    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.document).toEqual({ type: 'CPF', value: '529.982.247-25' })
    expect('address' in body).toBe(false)
  })

  it('não envia address para CNPJ, mesmo quando um endereço é fornecido', async () => {
    const fetchSpy = vi.fn(async () => ok())
    vi.stubGlobal('fetch', fetchSpy)

    await createValidation('12.345.678/0001-95', 'fast', address)

    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.document).toEqual({ type: 'CNPJ', value: '12.345.678/0001-95' })
    expect('address' in body).toBe(false)
  })
})

describe('getAddressByCep', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normaliza a resposta da BrasilAPI para o formulário', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            street: 'Avenida Paulista',
            neighborhood: 'Bela Vista',
            city: 'São Paulo',
            state: 'SP',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getAddressByCep('01310-100')).resolves.toEqual({
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      municipio: 'São Paulo',
      uf: 'SP',
    })
    expect(fetchSpy).toHaveBeenCalledWith('https://brasilapi.com.br/api/cep/v2/01310100', {
      signal: undefined,
    })
  })

  it('retorna null para CEP inexistente', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    )

    await expect(getAddressByCep('00000-000')).resolves.toBeNull()
  })

  it('usa ViaCEP quando a BrasilAPI não responde', async () => {
    const fetchSpy = vi.fn(async (input: string | URL) => {
      if (String(input).includes('brasilapi.com.br')) return new Response(null, { status: 503 })
      return new Response(
        JSON.stringify({
          logradouro: 'Avenida Paulista',
          bairro: 'Bela Vista',
          localidade: 'São Paulo',
          uf: 'SP',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getAddressByCep('01310-100')).resolves.toEqual({
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      municipio: 'São Paulo',
      uf: 'SP',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
