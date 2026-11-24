import { createHash } from 'node:crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export interface StoredObject {
  readonly key: string
  readonly uri: string
  readonly sha256: Buffer
  readonly bytes: number
}

export interface ObjectStore {
  readonly put: (key: string, data: Uint8Array, contentType: string) => Promise<StoredObject>
  readonly delete: (key: string) => Promise<void>
}

/**
 * Capacidade de leitura do object storage usada pela análise de documento
 * (F1.2). É separada de `ObjectStore` para que o intake/retenção continuem
 * podendo injetar stores que só escrevem/apagam em testes. O storage continua
 * privado: `get` recebe a chave opaca, nunca uma URL.
 */
export interface ObjectStoreReader {
  readonly get: (key: string) => Promise<Uint8Array | null>
}

/** Store completo (escrita + leitura) usado pelo worker e pela análise. */
export interface EvidenceObjectStore extends ObjectStore, ObjectStoreReader {}

export const sha256Of = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

export interface S3ObjectStoreOptions {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export const makeS3ObjectStore = (options: S3ObjectStoreOptions): EvidenceObjectStore => ({
  put: async (key, data, contentType) => {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    })
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      )
      return {
        key,
        uri: `${options.endpoint}/${options.bucket}/${key}`,
        sha256: sha256Of(data),
        bytes: data.byteLength,
      }
    } finally {
      client.destroy()
    }
  },
  get: async (key) => {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    })
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))
      if (response.Body === undefined) return null
      return await response.Body.transformToByteArray()
    } catch (error) {
      if ((error as { name?: unknown }).name === 'NoSuchKey') return null
      throw error
    } finally {
      client.destroy()
    }
  },
  delete: async (key) => {
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    })
    try {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
    } finally {
      client.destroy()
    }
  },
})

/**
 * Provedores de object storage suportados. A fábrica `makeObjectStore` escolhe
 * o adapter com base neste valor, então migrar de um provedor para outro é
 * apenas uma mudança de configuração — sem tocar nos consumidores.
 */
export type ObjectStoreProvider = 's3' | 'supabase' | 'unavailable'

interface SupabaseObjectStoreOptions {
  readonly supabaseUrl: string
  readonly supabaseServiceRoleKey: string
  readonly bucket: string
}

/**
 * Opções da fábrica genérica de object store. Só o provedor selecionado
 * precisa de opções; os demais são ignorados.
 */
export interface ObjectStoreFactoryOptions {
  readonly provider: ObjectStoreProvider
  readonly s3?: S3ObjectStoreOptions
  readonly supabase?: SupabaseObjectStoreOptions
  readonly supabaseRetry?: SupabaseRetryOptions
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
        throw new Error(
          'object store: opções do Supabase são obrigatórias para o provedor "supabase"',
        )
      return makeSupabaseObjectStore(opts.supabase, undefined, opts.supabaseRetry ?? {})
    }
    case 'unavailable':
      return makeUnavailableObjectStore(opts.unavailableReason)
    default:
      return makeUnavailableObjectStore()
  }
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
 * Adaptador do ObjectStore sobre Supabase Storage (bucket privado `evidence`).
 *
 * Usa a service role key do Supabase para contornar o RLS no backend: o
 * cliente nunca é exposto ao frontend, e todas as decisões de autorização
 * permanecem na aplicação. O bucket deve ser privado (sem acesso público, sem
 * upload anônimo).
 *
 * As chaves de objeto seguem o padrão existente do Comprova:
 * `tenants/<tenant>/evidence/<artifactId>`.
 */
/**
 * Superfície mínima do cliente que o adaptador usa (`storage.from` com
 * upload/download/remove). O `createSupabaseClient` real satisfaz este tipo
 * structuralmente e mocks de teste também, sem precisar implementar o client
 * inteiro. Se as assinaturas reais divergirem, o `?? createSupabaseClient`
 * abaixo falha no tsc.
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

export const makeSupabaseObjectStore = (
  options: SupabaseObjectStoreOptions,
  /** Injeção de dependência para testes: permite passar um createClient mock. */
  _createClient?: (
    url: string,
    key: string,
    options?: { auth?: { persistSession?: boolean; autoRefreshToken?: boolean } },
  ) => SupabaseStorageClient,
  /**
   * Política de retry para erros transitórios (5xx, 429 e falhas de rede). A
   * plataforma Supabase degrada de forma intermitente (ex.: incidente de
   * 2026-11 em que o Storage devolvia 500 "prepared statement does not
   * exist"); repetir a operação recupera a request sem ação do usuário.
   */
  retry: SupabaseRetryOptions = {},
): EvidenceObjectStore => {
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

/**
 * Store fail-closed para quando o object storage não foi configurado. Evita
 * cair silenciosamente em memória em produção: o intake responde 503 e nada é
 * aceito. Testes injetam um store explícito no `buildApp`.
 */
export const makeUnavailableObjectStore = (
  reason = 'object storage is not configured',
): EvidenceObjectStore => ({
  put: async () => {
    throw new Error(reason)
  },
  get: async () => {
    throw new Error(reason)
  },
  delete: async () => {
    throw new Error(reason)
  },
})

export const makeFakeObjectStore = (): EvidenceObjectStore => {
  const stored = new Map<string, Uint8Array>()
  return {
    put: async (key, data) => {
      stored.set(key, Uint8Array.from(data))
      return {
        key,
        uri: `memory://${key}`,
        sha256: sha256Of(data),
        bytes: data.byteLength,
      }
    },
    get: async (key) => {
      const data = stored.get(key)
      return data === undefined ? null : Uint8Array.from(data)
    },
    delete: async (key) => {
      stored.delete(key)
    },
  }
}
