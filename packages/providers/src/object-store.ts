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

interface SupabaseObjectStoreOptions {
  readonly supabaseUrl: string
  readonly supabaseServiceRoleKey: string
  readonly bucket: string
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
export const makeSupabaseObjectStore = (
  options: SupabaseObjectStoreOptions,
  /** Injeção de dependência para testes: permite passar um createClient mock. */
  _createClient?: (
    url: string,
    key: string,
    options?: { auth?: { persistSession?: boolean; autoRefreshToken?: boolean } },
  ) => ReturnType<typeof createSupabaseClient>,
): EvidenceObjectStore => {
  const createClientFn = _createClient ?? createSupabaseClient
  let supabase: ReturnType<typeof createSupabaseClient> | null = null
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
    put: async (key, data, contentType) => {
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
    },
    get: async (key) => {
      const { data, error } = await getClient().storage.from(bucket).download(key)
      if (error) {
        // 404 = objeto inexistente; tratamos como null (idempotente)
        if ((error as { statusCode?: number }).statusCode === 404) return null
        throw error
      }
      return new Uint8Array(await data.arrayBuffer())
    },
    delete: async (key) => {
      const { error } = await getClient().storage.from(bucket).remove([key])
      if (error) throw error
    },
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
