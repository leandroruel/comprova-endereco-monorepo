import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer } from '@testcontainers/redis'

export interface TestDb {
  adminUrl: string
  appUrl: string
  stop(): Promise<void>
}

export interface TestRedis {
  url: string
  stop(): Promise<void>
}

const APP_PASSWORD = 'test_app_pw'

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start()
  const uri = container.getConnectionUri()
  const url = new URL(uri)
  const appUrl = `postgres://app_user:${APP_PASSWORD}@${url.hostname}:${url.port}${url.pathname}`
  return {
    adminUrl: uri,
    appUrl,
    stop: async () => {
      await container.stop()
    },
  }
}

export async function startTestRedis(): Promise<TestRedis> {
  const container = await new RedisContainer('valkey/valkey:8-alpine').start()
  const url = container.getConnectionUrl()
  return {
    url,
    stop: async () => {
      await container.stop()
    },
  }
}

export const TEST_APP_DB_PASSWORD = APP_PASSWORD
