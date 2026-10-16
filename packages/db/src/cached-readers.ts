import { createHash } from 'node:crypto'
import type {
  CnaeCategoria,
  CepReader,
  CepRecord,
  CnefeReader,
  CnefeMatch,
  EstabelecimentoRecord,
  KnownSharedReader,
  ProfileReader,
  AddressProfileRecord,
  OtherActiveCnpj,
  RegistryReader,
  SignalCacheReader,
} from '@comprova/core'
import { type CacheStore } from './cache.js'
import {
  makeCepReader,
  makeCnaeCategoriaReader,
  makeCnefeCoordReader,
  makeCnefeReader,
  makeKnownSharedReader,
  makePartnerGraphReader,
  makeProfileReader,
  makeRegistryReader,
  makeSignalCacheReader,
} from './adapters.js'
import type { Db } from './client.js'

const CACHED_NULL = '__CACHED_NULL__'

const encodeKey = (parts: readonly (string | number | Uint8Array)[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)

export interface CachedReaders {
  readonly registry: RegistryReader
  readonly cep: CepReader
  readonly cnefe: CnefeReader
  readonly cnefeCoords: ReturnType<typeof makeCnefeCoordReader>
  readonly profile: ProfileReader
  readonly knownShared: KnownSharedReader
  readonly cnaeCategoria: ReturnType<typeof makeCnaeCategoriaReader>
  readonly partnerGraph: ReturnType<typeof makePartnerGraphReader>
  readonly signalCache: SignalCacheReader
  readonly raw: {
    readonly registry: RegistryReader
    readonly cep: CepReader
    readonly profile: ProfileReader
  }
}

const TTL = {
  registry: 86_400,
  cep: 604_800,
  cnefe: 2_592_000,
  cnefeCoords: 2_592_000,
  profile: 86_400,
  knownShared: 604_800,
  cnaeCategoria: 7_776_000,
  partnerGraph: 43_200,
  otherCnpjs: 86_400,
} as const

export const makeCachedReaders = (db: Db, cache: CacheStore): CachedReaders => {
  const rawRegistry = makeRegistryReader(db)
  const rawCep = makeCepReader(db)
  const rawCnefe = makeCnefeReader(db)
  const rawCnefeCoords = makeCnefeCoordReader(db)
  const rawProfile = makeProfileReader(db)
  const rawKnownShared = makeKnownSharedReader(db)
  const rawCnaeCategoria = makeCnaeCategoriaReader(db)
  const rawPartnerGraph = makePartnerGraphReader(db)
  const rawSignalCache = makeSignalCacheReader(db)

  const registry: RegistryReader = {
    getEstabelecimento: async (cnpj) => {
      const key = `reg:${encodeKey([cnpj.basico, cnpj.ordem, cnpj.dv])}`
      const cached = await cache.get<EstabelecimentoRecord | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return null
      if (cached !== null) return cached
      const result = await rawRegistry.getEstabelecimento(cnpj)
      await cache.set(key, result ?? CACHED_NULL, TTL.registry)
      return result
    },
  }

  const cep: CepReader = {
    get: async (cepStr) => {
      const key = `cep:${cepStr}`
      const cached = await cache.get<CepRecord | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return null
      if (cached !== null) return cached
      const result = await rawCep.get(cepStr)
      await cache.set(key, result ?? CACHED_NULL, TTL.cep)
      return result
    },
  }

  const cnefe: CnefeReader = {
    findAddress: async (query) => {
      const key = `cnefe:${encodeKey([query.municipioIbge, query.logradouroNorm, query.numero])}`
      const cached = await cache.get<CnefeMatch | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return null
      if (cached !== null) return cached
      const result = await rawCnefe.findAddress(query)
      await cache.set(key, result ?? CACHED_NULL, TTL.cnefe)
      return result
    },
  }

  const cnefeCoords = {
    coordFor: async (query: {
      readonly municipioIbge: number
      readonly logradouroNorm: string
      readonly numero: string
    }) => {
      const key = `cnefeCoord:${encodeKey([query.municipioIbge, query.logradouroNorm, query.numero])}`
      const cached = await cache.get<{ lat: number; lon: number } | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return null
      if (cached !== null) return cached
      const result = await rawCnefeCoords.coordFor(query)
      await cache.set(key, result ?? CACHED_NULL, TTL.cnefeCoords)
      return result
    },
  }

  const profile: ProfileReader = {
    getProfile: async (buildingKey) => {
      const key = `prof:${encodeKey([Buffer.from(buildingKey).toString('hex')])}`
      const cached = await cache.get<AddressProfileRecord | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return null
      if (cached !== null) return cached
      const result = await rawProfile.getProfile(buildingKey)
      await cache.set(key, result ?? CACHED_NULL, TTL.profile)
      return result
    },
    getOtherActiveCnpjs: async (buildingKey, excludeBasico) => {
      const key = `others:${encodeKey([Buffer.from(buildingKey).toString('hex'), excludeBasico])}`
      const cached = await cache.get<readonly OtherActiveCnpj[] | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return []
      if (cached !== null) return cached
      const result = await rawProfile.getOtherActiveCnpjs(buildingKey, excludeBasico)
      await cache.set(key, result.length > 0 ? result : CACHED_NULL, TTL.otherCnpjs)
      return result
    },
  }

  const knownShared: KnownSharedReader = {
    get: async (buildingKey) => {
      const key = `shared:${encodeKey([Buffer.from(buildingKey).toString('hex')])}`
      const cached = await cache.get<{ kind: string } | typeof CACHED_NULL>(key)
      if (cached === CACHED_NULL) return null
      if (cached !== null) return cached
      const result = await rawKnownShared.get(buildingKey)
      await cache.set(key, result ?? CACHED_NULL, TTL.knownShared)
      return result
    },
  }

  const cnaeCategoria = {
    categoriaForDivisao: async (divisao: string): Promise<CnaeCategoria> => {
      const key = `cnae:${divisao}`
      const cached = await cache.get<CnaeCategoria>(key)
      if (cached !== null) return cached
      const result = await rawCnaeCategoria.categoriaForDivisao(divisao)
      await cache.set(key, result, TTL.cnaeCategoria)
      return result
    },
  }

  const partnerGraph = {
    statsFor: async (query: { readonly buildingKey: Uint8Array; readonly cnpjBasico: string }) => {
      const key = `pgraph:${encodeKey([Buffer.from(query.buildingKey).toString('hex'), query.cnpjBasico])}`
      const cached = await cache.get<Record<string, unknown>>(key)
      if (cached !== null) return cached as never
      const result = await rawPartnerGraph.statsFor(query)
      await cache.set(key, result, TTL.partnerGraph)
      return result
    },
  }

  const signalCache: SignalCacheReader = rawSignalCache

  return {
    registry,
    cep,
    cnefe,
    cnefeCoords,
    profile,
    knownShared,
    cnaeCategoria,
    partnerGraph,
    signalCache,
    raw: { registry: rawRegistry, cep: rawCep, profile: rawProfile },
  }
}

export const cacheKeys = {
  invalidateRegistry: async (cache: CacheStore) => {
    await cache.delPattern('reg:*')
  },
  invalidateCep: async (cache: CacheStore) => {
    await cache.delPattern('cep:*')
  },
  invalidateCnefe: async (cache: CacheStore) => {
    await cache.delPattern('cnefe:*')
    await cache.delPattern('cnefeCoord:*')
  },
  invalidateProfiles: async (cache: CacheStore) => {
    await cache.delPattern('prof:*')
    await cache.delPattern('others:*')
  },
  invalidateKnownShared: async (cache: CacheStore) => {
    await cache.delPattern('shared:*')
  },
  invalidateAll: async (cache: CacheStore) => {
    for (const pattern of ['reg:*', 'cep:*', 'cnefe:*', 'cnefeCoord:*', 'prof:*', 'others:*', 'shared:*']) {
      await cache.delPattern(pattern)
    }
  },
}
