import type { ClientRequest, IncomingHttpHeaders } from 'node:http'
import type { RequestOptions } from 'node:https'

/**
 * Opções da guarda de fetch externo.
 *
 * Os limites são normalizados para uma faixa segura; valores fora dela são
 * truncados, nunca desativam a proteção.
 */
export interface SafeFetchOptions {
  readonly method?: 'GET' | 'POST' | 'HEAD'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /** Se informado, a resposta precisa ter um destes MIME types (sem parâmetros). */
  readonly allowedContentTypes?: readonly string[]
  /** Limitado a [1s, 15s]; default 8s. */
  readonly timeoutMs?: number
  /** Limitado a [1 KiB, 5 MiB]; default 256 KiB. */
  readonly maxResponseBytes?: number
  /** Limitado a [4 KiB, 64 KiB]; default 16 KiB. */
  readonly maxHeaderBytes?: number
}

export interface SafeFetchResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  /** IP validado efetivamente usado na conexão. */
  readonly address: string
}

export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>

export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type SafeFetchResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

/**
 * Injeta apenas a conexão de transporte. Ainda é a guarda que valida URL, DNS,
 * IP, redirect, limites e content-type. Usado pelo teste com servidor HTTPS
 * local; produção usa `https.request` direto.
 */
export type SafeFetchTransport = (options: RequestOptions) => ClientRequest

export interface SafeFetchFactoryOptions {
  readonly resolve?: SafeFetchResolver
  readonly transport?: SafeFetchTransport
  /** CA extra, apenas para o teste local com certificado autoassinado. */
  readonly ca?: string | Buffer | (string | Buffer)[]
}

export const SAFE_FETCH_CONNECT_TIMEOUT_MS = 3_000
export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 8_000
export const SAFE_FETCH_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
export const SAFE_FETCH_DEFAULT_MAX_HEADER_BYTES = 16 * 1024
export const SAFE_FETCH_MAX_REQUEST_BYTES = 1024 * 1024
