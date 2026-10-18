import type { CacheStore, Db } from '@comprova/db'
import { getDatasetMeta } from './meta.service.js'

export interface MetaControllerDeps {
  readonly db: Db
  readonly cache: CacheStore
}

export const makeMetaController = (deps: MetaControllerDeps) => ({
  get: async () => getDatasetMeta(deps.db, deps.cache),
})
