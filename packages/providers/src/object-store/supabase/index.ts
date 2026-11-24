import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { sha256Of } from '../types.js'

export interface SupabaseObjectStoreOptions {
  readonly supabaseUrl: string
  readonly supabaseServiceRoleKey: string
  readonly bucket: string
}

export interface SupabaseRetryOptions {
  /** Número total de tentativas por operação (1 desliga o retry). Default: 3. */
  readonly attempts?: number
  /** Atraso base entre tentativas, multiplicado pelo número da tentativa. Default: 200. */
  readonly baseDelayMs?: number
  /** Injetável para testes. */
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 200

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Normaliza o status HTTP dos erros do storage-js: `StorageApiError` expõe
 * `status` (number) e `statusCode` (string), mocks e wrappers variam entre os
 * dois formatos.
 */
const storageStatusOf = (error: unknown): number | null => {
  if (error === null || typeof error !== 'object') return null
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown }
  if (typeof status === 'number') return status
  if (typeof statusCode === 'number') return statusCode
  if (typeof statusCode === 'string' && /^\d{3}$/.test(statusCode)) return Number(statusCode)
  return null
}

/**
 * Erros transitórios do Storage: 5xx e 429 vindos da API e falhas de rede sem
 * status (`StorageUnknownError` do storage-js, `FetchError`/`TypeError` do
 * runtime). 4xx são definitivos (bucket ausente, objeto duplicado, permissão)
 * e falham na primeira tentativa.
 */
const isTransientStorageError = (error: unknown): boolean => {
  const status = storageStatusOf(error)
  if (status !== null) return status >= 500 || status === 429
  if (error === null || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'StorageUnknownError' || name === 'FetchError' || name === 'TypeError'
}

const withStorageRetry = async <T>(operation: () => Promise<T>, retry: SupabaseRetryOptions): Promise<T> => {
  const attempts = Math.max(1, retry.attempts ?? DEFAULT_RETRY_ATTEMPTS)
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const sleep = retry.sleep ?? sleepFor
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransientStorageError(error)) break
      await sleep(baseDelayMs * attempt)
    }
  }
  throw lastError
}

/**
 * Superfície mínima do cliente que o adaptador usa (`storage.from` com
 * upload/download/remove). O `createSupabaseClient` real satisfaz este tipo
 * structuralmente e mocks de teste também, sem precisar implementar o client
 * inteiro.
 */
interface SupabaseStorageClient {
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        fileBody: Uint8Array | Blob | ArrayBuffer | ArrayBufferView,
        fileOptions?: { contentType?: string; upsert?: boolean },
      ) => PromiseLike<{ data?: unknown; error: unknown }>
      download: (path: string) => PromiseLike<{ data: Blob | null; error: unknown }>
      remove: (paths: string[]) => PromiseLike<{ data?: unknown; error: unknown }>
    }
  }
}

/**
 * Adaptador do ObjectStore sobre Supabase Storage (bucket privado `evidence`).
 *
 * Usa a service role key do Supabase para contornar o RLS no backend: o
 * cliente nunca é exposto ao frontend, e todas as decisões de autorização
 * permanecem na aplicação. O bucket deve ser privado (sem acesso público, sem
 * upload anônimo).
 *
 * As chaves de objeto seguem o padrão existente do Comprova:
 * `tenants/<tenant>/evidence/<artifactId>`.
 *
 * Inclui retry com backoff para erros transitórios (5xx, 429 e falhas de
 * rede), recuperando degradações intermitentes do Storage do Supabase
 * (ex.: "prepared statement does not exist") sem ação do usuário.
 */
export const makeSupabaseObjectStore = (
  options: SupabaseObjectStoreOptions,
  /** Injeção de dependência para testes: permite passar um createClient mock. */
  _createClient?: (
    url: string,
    key: string,
    options?: { auth?: { persistSession?: boolean; autoRefreshToken?: boolean } },
  ) => SupabaseStorageClient,
  /**
   * Política de retry para erros transitórios (5xx, 429 e falhas de rede).
   */
  retry: SupabaseRetryOptions = {},
): import('../types.js').EvidenceObjectStore => {
  const createClientFn = _createClient ?? createSupabaseClient
  let supabase: SupabaseStorageClient | null = null
  const bucket = options.bucket
  const getClient = () => {
    if (supabase === null) {
      supabase = createClientFn(options.supabaseUrl, options.supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    }
    return supabase!
  }

  return {
    put: (key, data, contentType) =>
      withStorageRetry(async () => {
        const { error } = await getClient().storage.from(bucket).upload(key, data, {
          contentType,
          upsert: false,
        })
        if (error) throw error
        return {
          key,
          uri: `${options.supabaseUrl}/storage/v1/object/public/${bucket}/${key}`,
          sha256: sha256Of(data),
          bytes: data.byteLength,
        }
      }, retry),
    get: (key) =>
      withStorageRetry(async () => {
        const { data, error } = await getClient().storage.from(bucket).download(key)
        if (error) {
          // 404 = objeto inexistente; tratamos como null (idempotente)
          if (storageStatusOf(error) === 404) return null
          throw error
        }
        if (data === null) return null
        return new Uint8Array(await data.arrayBuffer())
      }, retry),
    delete: (key) =>
      withStorageRetry(async () => {
        const { error } = await getClient().storage.from(bucket).remove([key])
        if (error) throw error
      }, retry),
  }
}
