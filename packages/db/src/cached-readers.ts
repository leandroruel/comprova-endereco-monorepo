import { createHash } from 'node:crypto'
import type {
  AddressProfileRecord,
  CepReader,
  CepRecord,
  CnefeMatch,
  CnefeReader,
  EstabelecimentoRecord,
  KnownSharedReader,
  OtherActiveCnpj,
  ProfileReader,
  RegistryReader,
  SignalCacheReader,
} from '@comprova/core'
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
} from './adapters/index.js'
import { readThrough, readThroughValue } from './cached-read.js'
import { type CacheStore } from './cache.js'
import type { Db } from './client.js'

const encodeKey = (parts: readonly (string | number | Uint8Array)[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)

/** Chave hexadecimal estável para compor a chave de cache de um endereço. */
const buildingKeyHex = (buildingKey: Uint8Array): string => Buffer.from(buildingKey).toString('hex')

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

type CnefeCoord = { readonly lat: number; readonly lon: number }

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
    getEstabelecimento: (cnpj) =>
      readThrough<EstabelecimentoRecord | null>({
        cache,
        key: `reg:${encodeKey([cnpj.basico, cnpj.ordem, cnpj.dv])}`,
        ttlSeconds: TTL.registry,
        load: () => rawRegistry.getEstabelecimento(cnpj),
        fallback: null,
      }),
  }

  const cep: CepReader = {
    get: (cepStr) =>
      readThrough<CepRecord | null>({
        cache,
        key: `cep:${cepStr}`,
        ttlSeconds: TTL.cep,
        load: () => rawCep.get(cepStr),
        fallback: null,
      }),
  }

  const cnefe: CnefeReader = {
    findAddress: (query) =>
      readThrough<CnefeMatch | null>({
        cache,
        key: `cnefe:${encodeKey([query.municipioIbge, query.logradouroNorm, query.numero])}`,
        ttlSeconds: TTL.cnefe,
        load: () => rawCnefe.findAddress(query),
        fallback: null,
      }),
  }

  const cnefeCoords = {
    coordFor: (query: {
      readonly municipioIbge: number
      readonly logradouroNorm: string
      readonly numero: string
    }) =>
      readThrough<CnefeCoord | null>({
        cache,
        key: `cnefeCoord:${encodeKey([query.municipioIbge, query.logradouroNorm, query.numero])}`,
        ttlSeconds: TTL.cnefeCoords,
        load: () => rawCnefeCoords.coordFor(query),
        fallback: null,
      }),
  }

  const profile: ProfileReader = {
    getProfile: (buildingKey) =>
      readThrough<AddressProfileRecord | null>({
        cache,
        key: `prof:${encodeKey([buildingKeyHex(buildingKey)])}`,
        ttlSeconds: TTL.profile,
        load: () => rawProfile.getProfile(buildingKey),
        fallback: null,
      }),
    getOtherActiveCnpjs: (buildingKey, excludeBasico) =>
      readThrough<readonly OtherActiveCnpj[]>({
        cache,
        key: `others:${encodeKey([buildingKeyHex(buildingKey), excludeBasico])}`,
        ttlSeconds: TTL.otherCnpjs,
        load: () => rawProfile.getOtherActiveCnpjs(buildingKey, excludeBasico),
        fallback: [],
        missingWhen: (rows) => rows.length === 0,
      }),
  }

  const knownShared: KnownSharedReader = {
    get: (buildingKey) =>
      readThrough<{ readonly kind: string } | null>({
        cache,
        key: `shared:${encodeKey([buildingKeyHex(buildingKey)])}`,
        ttlSeconds: TTL.knownShared,
        load: () => rawKnownShared.get(buildingKey),
        fallback: null,
      }),
  }

  const cnaeCategoria = {
    categoriaForDivisao: (divisao: string) =>
      readThroughValue(cache, `cnae:${divisao}`, TTL.cnaeCategoria, () =>
        rawCnaeCategoria.categoriaForDivisao(divisao),
      ),
  }

  const partnerGraph = {
    statsFor: (query: { readonly buildingKey: Uint8Array; readonly cnpjBasico: string }) =>
      readThroughValue(
        cache,
        `pgraph:${encodeKey([buildingKeyHex(query.buildingKey), query.cnpjBasico])}`,
        TTL.partnerGraph,
        () => rawPartnerGraph.statsFor(query),
      ),
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
