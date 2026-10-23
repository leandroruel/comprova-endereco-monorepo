import { createHash } from 'node:crypto'

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
    await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
  },
})

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
