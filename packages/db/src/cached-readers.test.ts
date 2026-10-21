import type { EstabelecimentoRecord } from '@comprova/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheStore } from './cache.js'
import type { Db } from './client.js'

const adapters = vi.hoisted(() => ({
  registryGet: vi.fn(),
  cepGet: vi.fn(),
  cnefeFind: vi.fn(),
  cnefeCoord: vi.fn(),
  profileGet: vi.fn(),
  otherCnpjs: vi.fn(),
  knownSharedGet: vi.fn(),
  cnae: vi.fn(),
  partner: vi.fn(),
  signal: vi.fn(),
}))

vi.mock('./adapters/index.js', () => ({
  makeRegistryReader: () => ({ getEstabelecimento: adapters.registryGet }),
  makeCepReader: () => ({ get: adapters.cepGet }),
  makeCnefeReader: () => ({ findAddress: adapters.cnefeFind }),
  makeCnefeCoordReader: () => ({ coordFor: adapters.cnefeCoord }),
  makeProfileReader: () => ({
    getProfile: adapters.profileGet,
    getOtherActiveCnpjs: adapters.otherCnpjs,
  }),
  makeKnownSharedReader: () => ({ get: adapters.knownSharedGet }),
  makeCnaeCategoriaReader: () => ({ categoriaForDivisao: adapters.cnae }),
  makePartnerGraphReader: () => ({ statsFor: adapters.partner }),
  makeSignalCacheReader: () => ({ getCached: adapters.signal }),
}))

import { CACHED_NULL } from './cached-read.js'
import { makeCachedReaders } from './cached-readers.js'

const makeMemoryCache = (): CacheStore & { readonly entries: Map<string, unknown> } => {
  const entries = new Map<string, unknown>()
  return {
    entries,
    get: async <T>(key: string): Promise<T | null> => (entries.has(key) ? (entries.get(key) as T) : null),
    set: async <T>(key: string, value: T): Promise<void> => {
      entries.set(key, value)
    },
    del: async (key: string): Promise<void> => {
      entries.delete(key)
    },
    delPattern: async (): Promise<number> => 0,
    stats: () => ({ hits: 0, misses: 0, sets: 0, errors: 0 }),
  }
}

const makeReaders = (cache: CacheStore) => makeCachedReaders({} as Db, cache)

const estabelecimento = {
  cnpjBasico: '12345678',
  cnpjOrdem: '0001',
  cnpjDv: '90',
  matrizFilial: 1,
  nomeFantasia: 'Empresa Exemplo',
  situacaoCadastral: 2,
  dataSituacao: null,
  motivoSituacao: null,
  dataAbertura: null,
  cnaePrincipal: null,
  cnaesSecundarios: null,
  tipoLogradouro: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cep: null,
  uf: null,
  municipioReceita: null,
  municipioIbge: null,
  paisCodigo: null,
  cidadeExterior: null,
  telefone: null,
  emailDomain: null,
  buildingKey: null,
  unitKey: null,
} satisfies EstabelecimentoRecord

const cnpjQuery = { basico: '12345678', ordem: '0001', dv: '90' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('makeCachedReaders', () => {
  it('serve o estabelecimento do cache na segunda leitura', async () => {
    const cache = makeMemoryCache()
    const readers = makeReaders(cache)
    adapters.registryGet.mockResolvedValue(estabelecimento)

    expect(await readers.registry.getEstabelecimento(cnpjQuery)).toEqual(estabelecimento)
    expect(await readers.registry.getEstabelecimento(cnpjQuery)).toEqual(estabelecimento)
    expect(adapters.registryGet).toHaveBeenCalledTimes(1)
  })

  it('marca ausência do registry como CACHED_NULL e não repete a consulta', async () => {
    const cache = makeMemoryCache()
    const readers = makeReaders(cache)
    adapters.registryGet.mockResolvedValue(null)

    expect(await readers.registry.getEstabelecimento(cnpjQuery)).toBeNull()
    expect(await readers.registry.getEstabelecimento(cnpjQuery)).toBeNull()
    expect(adapters.registryGet).toHaveBeenCalledTimes(1)
    expect([...cache.entries.values()]).toContain(CACHED_NULL)
  })

  it('cacheia lista vazia de CNPJs vizinhos como ausência', async () => {
    const cache = makeMemoryCache()
    const readers = makeReaders(cache)
    adapters.otherCnpjs.mockResolvedValue([])

    expect(await readers.profile.getOtherActiveCnpjs(new Uint8Array([1]), '12345678')).toEqual([])
    expect(await readers.profile.getOtherActiveCnpjs(new Uint8Array([1]), '12345678')).toEqual([])
    expect(adapters.otherCnpjs).toHaveBeenCalledTimes(1)
    expect([...cache.entries.values()]).toContain(CACHED_NULL)
  })

  it('cacheia a categoria CNAE, que sempre tem valor', async () => {
    const cache = makeMemoryCache()
    const readers = makeReaders(cache)
    adapters.cnae.mockResolvedValue('COMMERCIAL')

    expect(await readers.cnaeCategoria.categoriaForDivisao('62')).toBe('COMMERCIAL')
    expect(await readers.cnaeCategoria.categoriaForDivisao('62')).toBe('COMMERCIAL')
    expect(adapters.cnae).toHaveBeenCalledTimes(1)
  })

  it('cacheia o grafo de sócios com o tipo do adaptador', async () => {
    const cache = makeMemoryCache()
    const readers = makeReaders(cache)
    const stats = {
      coLocatedCnpjs: 2,
      cnpjsSharingPartner: 1,
      recentOpeningsAtAddress: 0,
      hasData: true,
    }
    adapters.partner.mockResolvedValue(stats)

    expect(
      await readers.partnerGraph.statsFor({ buildingKey: new Uint8Array([1]), cnpjBasico: '2' }),
    ).toEqual(stats)
    expect(
      await readers.partnerGraph.statsFor({ buildingKey: new Uint8Array([1]), cnpjBasico: '2' }),
    ).toEqual(stats)
    expect(adapters.partner).toHaveBeenCalledTimes(1)
  })
})
