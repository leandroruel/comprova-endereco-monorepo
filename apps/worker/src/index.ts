import { Worker } from '@temporalio/worker'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDeepWorkerContext, makeDeepEnrichActivity, workerEnvFromProcess } from './activities.js'
import { makeFakeObjectStore, makeS3ObjectStore } from '@comprova/providers'
import { createDbPool } from '@comprova/db'
import { startRetentionLoop } from './evidence.js'

const env = workerEnvFromProcess()
const ctx = buildDeepWorkerContext(env)
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'comprova-deep-t1'

const workflowsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows', 'deep.ts')

const retentionStore =
  env.s3Endpoint !== undefined &&
  env.s3AccessKeyId !== undefined &&
  env.s3SecretAccessKey !== undefined &&
  env.s3Bucket !== undefined
    ? makeS3ObjectStore({
        endpoint: env.s3Endpoint,
        region: env.s3Region ?? 'us-east-1',
        bucket: env.s3Bucket,
        accessKeyId: env.s3AccessKeyId,
        secretAccessKey: env.s3SecretAccessKey,
      })
    : makeFakeObjectStore()
const retentionDb = createDbPool(env.databaseUrl)
const stopRetention = startRetentionLoop(retentionDb.db, retentionStore)

const worker = await Worker.create({
  taskQueue,
  workflowsPath,
  activities: { deepEnrichActivity: makeDeepEnrichActivity(ctx) },
})

console.log(`worker listening on task queue ${taskQueue} (retention loop active)`)
try {
  await worker.run()
} finally {
  stopRetention()
}
