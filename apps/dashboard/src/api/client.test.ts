import { afterEach, describe, expect, it, vi } from 'vitest'
import { createValidation, type AddressInput } from './client'

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
