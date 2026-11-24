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
