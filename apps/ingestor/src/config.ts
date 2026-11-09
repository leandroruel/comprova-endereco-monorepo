/**
 * Leitura do ambiente do ingestor. Centraliza o que antes era lido espalhado em
 * `process.env` (URL do banco, senha do papel de aplicação, Redis, pimenta das
 * chaves de API e nível de log) num único lugar, no mesmo padrão de
 * `apps/api/src/config.ts` e `apps/worker/src/config.ts`.
 */
export interface IngestorConfig {
  readonly adminUrl: string
  /** Admin do database de referência (CNEFE/Receita). Padrão: `adminUrl` (modo single-database). */
  readonly refAdminUrl: string
  readonly appDbPassword?: string
  readonly redisUrl: string
  readonly apiKeyPepper: string
  readonly logLevel: string
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined

export const ingestorConfigFromProcess = (env: NodeJS.ProcessEnv = process.env): IngestorConfig => {
  const adminUrl = nonEmpty(env.DATABASE_ADMIN_URL)
  if (adminUrl === undefined) throw new Error('DATABASE_ADMIN_URL is required')

  const appDbPassword = nonEmpty(env.APP_DB_PASSWORD)

  return {
    adminUrl,
    // Compat: sem REFERENCE_DATABASE_ADMIN_URL o ingestor segue no modo
    // single-database (ingestão e ingestão-manutenção no mesmo database).
    refAdminUrl: nonEmpty(env.REFERENCE_DATABASE_ADMIN_URL) ?? adminUrl,
    redisUrl: nonEmpty(env.REDIS_URL) ?? 'redis://localhost:6379',
    apiKeyPepper: nonEmpty(env.API_KEY_PEPPER) ?? 'dev-pepper-change-me',
    logLevel: nonEmpty(env.LOG_LEVEL) ?? 'info',
    ...(appDbPassword !== undefined ? { appDbPassword } : {}),
  }
}
