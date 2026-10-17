import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer } from '@testcontainers/redis'
import { GenericContainer, Wait } from 'testcontainers'

export interface TestDb {
  adminUrl: string
  appUrl: string
  stop(): Promise<void>
}

export interface TestRedis {
  url: string
  stop(): Promise<void>
}

export interface TestTemporal {
  /** Endereço `host:porta` do frontend gRPC, pronto para `Connection.connect`. */
  address: string
  stop(): Promise<void>
}

const APP_PASSWORD = 'test_app_pw'

/** Mesma imagem e comando do `docker-compose`, mas isolado por container. */
const TEMPORAL_IMAGE = 'temporalio/admin-tools:1.27.0'
const TEMPORAL_PORT = 7233
/** O dev server imprime a linha de bind do frontend quando está pronto para servir gRPC. */
const TEMPORAL_READY = /Server:\s+0\.0\.0\.0:7233/

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

/**
 * Sobe um Temporal real (dev server `start-dev`, SQLite em memória) em um
 * container efêmero. Nenhum estado é compartilhado com o Temporal de
 * desenvolvimento: cada chamada tem o seu próprio servidor e porta mapeada.
 */
export async function startTestTemporal(): Promise<TestTemporal> {
  const container = await new GenericContainer(TEMPORAL_IMAGE)
    .withEntrypoint(['temporal'])
    .withCommand(['server', 'start-dev', '--ip', '0.0.0.0', '--port', String(TEMPORAL_PORT), '--headless'])
    .withExposedPorts(TEMPORAL_PORT)
    .withWaitStrategy(Wait.forLogMessage(TEMPORAL_READY, 1).withStartupTimeout(60_000))
    .start()
  return {
    address: `${container.getHost()}:${container.getMappedPort(TEMPORAL_PORT)}`,
    stop: async () => {
      await container.stop()
    },
  }
}

export const TEST_APP_DB_PASSWORD = APP_PASSWORD
