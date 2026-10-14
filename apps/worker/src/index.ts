import { Worker } from '@temporalio/worker'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDeepWorkerContext, makeDeepEnrichActivity, workerEnvFromProcess } from './activities.js'

const env = workerEnvFromProcess()
const ctx = buildDeepWorkerContext(env)
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'comprova-deep-t1'
const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233'

const workflowsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows', 'deep.ts')

const worker = await Worker.create({
  taskQueue,
  workflowsPath,
  activities: { deepEnrichActivity: makeDeepEnrichActivity(ctx) },
  connection: undefined,
})

console.log(`worker listening on task queue ${taskQueue} at ${address}`)
await worker.run()
