import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { sha256Of, type EvidenceObjectStore } from '../types.js'

/** Root directory for object storage. Must be absolute or will be resolved from cwd. */
export interface LocalFSObjectStoreOptions {
  readonly rootPath: string
}

/**
 * Local filesystem object store for development and local testing.
 * Stores objects under `{rootPath}/tenants/{tenantId}/evidence/{artifactId}`.
 *
 * Not suitable for production multi-instance deployments (no distributed locking).
 * Intended for single-node local validation only.
 */
export const makeLocalFSObjectStore = (options: LocalFSObjectStoreOptions): EvidenceObjectStore => {
  const root = isAbsolute(options.rootPath) ? options.rootPath : resolve(process.cwd(), options.rootPath)

  const put = async (
    key: string,
    data: Uint8Array,
    _contentType: string,
  ): Promise<{
    readonly key: string
    readonly uri: string
    readonly sha256: Buffer
    readonly bytes: number
  }> => {
    const filePath = resolve(root, key)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, data)

    const sha256 = sha256Of(data)
    return {
      key,
      uri: `file://${filePath}`,
      sha256,
      bytes: data.byteLength,
    }
  }

  const get = async (key: string): Promise<Uint8Array | null> => {
    const filePath = resolve(root, key)
    try {
      const data = await readFile(filePath)
      return new Uint8Array(data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  const delete_ = async (key: string): Promise<void> => {
    const filePath = resolve(root, key)
    try {
      await unlink(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return { put, get, delete: delete_ }
}
