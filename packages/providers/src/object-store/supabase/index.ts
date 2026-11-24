import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { sha256Of, type EvidenceObjectStore } from '../types.js'

export interface SupabaseObjectStoreOptions {
  readonly supabaseUrl: string
  readonly supabaseServiceRoleKey: string
  readonly bucket: string
}

/**
 * Superfície mínima do cliente Supabase que o adaptador usa (`storage.from`
 * com upload/download/remove). O `createSupabaseClient` real satisfaz este
 * tipo structuralmente, e mocks de teste também, sem precisar reimplementar
 * o client inteiro.
 */
type SupabaseClientLike = {
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        fileBody: Uint8Array | Blob | ArrayBuffer | ArrayBufferView,
        fileOptions?: { contentType?: string; upsert?: boolean },
      ) => Promise<{ error: unknown }>
      download: (path: string) => Promise<{ data: Blob | null; error: unknown }>
      remove: (paths: string[]) => Promise<{ error: unknown }>
    }
  }
}

/**
 * Adaptador do ObjectStore sobre Supabase Storage (bucket privado `evidence`).
 *
 * Segue a API padrão do Supabase Storage:
 * https://supabase.com/docs/guides/storage/uploads/standard-uploads
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
  ) => SupabaseClientLike,
): EvidenceObjectStore => {
  const createClientFn = _createClient ?? createSupabaseClient
  let supabase: SupabaseClientLike | null = null
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
      if (data === null) return null
      return new Uint8Array(await data.arrayBuffer())
    },
    delete: async (key) => {
      const { error } = await getClient().storage.from(bucket).remove([key])
      if (error) throw error
    },
  }
}
