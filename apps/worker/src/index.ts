import { systemClock } from '@comprova/core'
import { createDbPool } from '@comprova/db'
import { createCLILogger } from '@comprova/observability'
import { makeDocumentAnalyzer } from '@comprova/providers'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerEnvFromProcess } from './config.js'
import { buildWorkerContext, makeObjectStore } from './context.js'
import {
  startEvidenceAnalysisLoop,
  startEvidenceRetentionLoop,
  startValidationRetentionLoop,
} from './loops.js'
import { makeDeepEnrichActivity } from './modules/deep-enrich/deep-enrich.activity.js'
import type { DeepEnrichDeps } from './modules/deep-enrich/deep-enrich.service.js'

const logger = createCLILogger('worker')
const env = workerEnvFromProcess()
const ctx = buildWorkerContext(env)
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'comprova-deep-t1'

const workflowsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows', 'deep.ts')

const deepDeps: DeepEnrichDeps = {
  db: ctx.pool.db,
  t1Checkers: ctx.t1Checkers,
  t2Checkers: ctx.t2Checkers,
  policy: ctx.policy,
  policyHash: ctx.policyHash,
  clock: systemClock,
  signalCache: ctx.signalCache,
}

// A retenção precisa de privilégio de manutenção (DATABASE_ADMIN_URL):
// remover `evidence` (sem DELETE para app_user) e varrer o grafo de validações
// expiradas de todos os tenants (RLS é por tenant). Ver ADR de retenção.
const adminUrl = process.env.DATABASE_ADMIN_URL
const adminRetentionPool = adminUrl !== undefined && adminUrl !== '' ? createDbPool(adminUrl) : null
const retentionPool = adminRetentionPool ?? createDbPool(env.databaseUrl)
const retentionStore = makeObjectStore(env)
const stopEvidenceRetention = startEvidenceRetentionLoop(retentionPool.db, retentionStore, logger)
const stopValidationRetention =
  adminRetentionPool !== null
    ? startValidationRetentionLoop(adminRetentionPool.db, retentionStore, logger)
    : null

// A análise atravessa tenants (fila global) e por isso usa o pool de
// manutenção. Sem `DATABASE_ADMIN_URL`, a RLS esconderia as linhas `pending`:
// o worker avisa e não sobe o loop, em vez de falhar silenciosamente.
const documentAnalyzer = makeDocumentAnalyzer()
const stopEvidenceAnalysis =
  adminRetentionPool !== null
    ? startEvidenceAnalysisLoop(
        adminRetentionPool.db,
        retentionStore,
        documentAnalyzer,
        env.evidenceAnalysisMaxBytes,
        logger,
      )
    : null
if (stopEvidenceAnalysis === null) {
  logger.warn(
    { reason: 'EVIDENCE_ANALYSIS_ADMIN_URL_MISSING' },
    'evidence analysis loop disabled: DATABASE_ADMIN_URL not configured',
  )
}

const worker = await Worker.create({
  taskQueue,
  workflowsPath,
  activities: { deepEnrichActivity: makeDeepEnrichActivity(deepDeps) },
})

logger.info({ taskQueue, retention: true }, 'worker listening')
try {
  await worker.run()
} finally {
  stopEvidenceRetention()
  stopValidationRetention?.()
  stopEvidenceAnalysis?.()
}
