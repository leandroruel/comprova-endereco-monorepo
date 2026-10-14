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

export const sha256Of = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

export interface S3ObjectStoreOptions {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export const makeS3ObjectStore = (options: S3ObjectStoreOptions): ObjectStore => ({
  put: async (key, data, contentType) => {
    const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
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

export const makeFakeObjectStore = (): ObjectStore => {
  const stored = new Map<string, Uint8Array>()
  return {
    put: async (key, data) => ({
      key,
      uri: `memory://${key}`,
      sha256: sha256Of(data),
      bytes: data.byteLength,
    }),
    delete: async (key) => {
      stored.delete(key)
    },
  }
}
