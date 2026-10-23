import { beforeEach, describe, expect, it, vi } from 'vitest'

const s3 = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: s3.send, destroy: s3.destroy }
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return input
  }),
  GetObjectCommand: vi.fn(function (input: unknown) {
    return input
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return input
  }),
}))

import { makeS3ObjectStore } from './object-store.js'

const makeStore = () =>
  makeS3ObjectStore({
    endpoint: 'https://s3.test',
    region: 'us-east-1',
    bucket: 'evidence',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  })

beforeEach(() => {
  s3.send.mockReset()
  s3.destroy.mockReset()
})

describe('makeS3ObjectStore', () => {
  it('destrói o client depois de put', async () => {
    s3.send.mockResolvedValue(undefined)

    const stored = await makeStore().put('tenants/a/evidence/1', new Uint8Array([1, 2]), 'application/pdf')

    expect(stored).toMatchObject({ key: 'tenants/a/evidence/1', bytes: 2 })
    expect(s3.destroy).toHaveBeenCalledTimes(1)
  })

  it('destrói o client depois de get', async () => {
    s3.send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2]) },
    })

    await expect(makeStore().get('tenants/a/evidence/1')).resolves.toEqual(new Uint8Array([1, 2]))
    expect(s3.destroy).toHaveBeenCalledTimes(1)
  })

  it('destrói o client quando get recebe NoSuchKey', async () => {
    s3.send.mockRejectedValue({ name: 'NoSuchKey' })

    await expect(makeStore().get('tenants/a/evidence/1')).resolves.toBeNull()
    expect(s3.destroy).toHaveBeenCalledTimes(1)
  })

  it('destrói o client quando get falha', async () => {
    s3.send.mockRejectedValue(new Error('timeout'))

    await expect(makeStore().get('tenants/a/evidence/1')).rejects.toThrow('timeout')
    expect(s3.destroy).toHaveBeenCalledTimes(1)
  })

  it('destrói o client depois de delete', async () => {
    s3.send.mockResolvedValue(undefined)

    await makeStore().delete('tenants/a/evidence/1')

    expect(s3.destroy).toHaveBeenCalledTimes(1)
  })
})
