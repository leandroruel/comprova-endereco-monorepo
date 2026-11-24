import { makeS3ObjectStore, type S3ObjectStoreOptions } from './s3/index.js'
import { makeSupabaseObjectStore, type SupabaseObjectStoreOptions } from './supabase/index.js'
import { makeUnavailableObjectStore } from './unavailable/index.js'
import { makeFakeObjectStore } from './fake/index.js'
import {
  type EvidenceObjectStore,
  type ObjectStore,
  type ObjectStoreReader,
  type StoredObject,
  sha256Of,
} from './types.js'

/**
 * Provedores de object storage suportados. A fábrica `makeObjectStore` escolhe
 * o adapter com base neste valor, então migrar de um provedor para outro é
 * apenas uma mudança de configuração — sem tocar nos consumidores.
 */
export type ObjectStoreProvider = 's3' | 'supabase' | 'unavailable'

/**
 * Opções da fábrica genérica de object store. Só o provedor selecionado
 * precisa de opções; os demais são ignorados.
 */
export interface ObjectStoreFactoryOptions {
  readonly provider: ObjectStoreProvider
  readonly s3?: S3ObjectStoreOptions
  readonly supabase?: SupabaseObjectStoreOptions
  readonly unavailableReason?: string
}

/**
 * Fábrica genérica de object store. Retorna um `EvidenceObjectStore` (o
 * contrato abstrato) construído pelo adapter do provedor escolhido.
 *
 * Novos provedores só precisam de um `make*ObjectStore` adapter e de um caso
 * neste `switch` — os consumidores (`buildApp`, testes) não mudam.
 */
export const makeObjectStore = (opts: ObjectStoreFactoryOptions): EvidenceObjectStore => {
  switch (opts.provider) {
    case 's3': {
      if (!opts.s3) throw new Error('object store: opções do S3 são obrigatórias para o provedor "s3"')
      return makeS3ObjectStore(opts.s3)
    }
    case 'supabase': {
      if (!opts.supabase)
        throw new Error('object store: opções do Supabase são obrigatórias para o provedor "supabase"')
      return makeSupabaseObjectStore(opts.supabase)
    }
    case 'unavailable':
      return makeUnavailableObjectStore(opts.unavailableReason)
    default:
      return makeUnavailableObjectStore()
  }
}

export {
  type EvidenceObjectStore,
  type ObjectStore,
  type ObjectStoreReader,
  type StoredObject,
  makeFakeObjectStore,
  makeS3ObjectStore,
  makeSupabaseObjectStore,
  makeUnavailableObjectStore,
  sha256Of,
  type S3ObjectStoreOptions,
  type SupabaseObjectStoreOptions,
}
