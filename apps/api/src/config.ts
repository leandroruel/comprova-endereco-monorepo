import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  API_KEY_PEPPER: z.string().min(8),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  POLICY_VERSION: z.string().default('2026.13.1'),
  TEMPORAL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  VLM_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE: z.string().default('comprova-deep-t1'),
  WORKER_LOOPS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
