import { sha256Of } from '../types.js'

export interface S3ObjectStoreOptions {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export const makeS3ObjectStore = (
  options: S3ObjectStoreOptions,
): import('../types.js').EvidenceObjectStore => ({
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
