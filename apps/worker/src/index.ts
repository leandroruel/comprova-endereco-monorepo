import { systemClock } from '@comprova/core'
import { createDbPool } from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { makeDocumentAnalyzer, makeNf3eFiscalAdapter } from '@comprova/providers'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerEnvFromProcess } from './config.js'
import { buildWorkerContext, hasS3Config, makeObjectStore } from './context.js'
import {
  startEvidenceAnalysisLoop,
  startEvidenceRetentionLoop,
  startEvidenceVerificationLoop,
  startFiscalVerificationLoop,
  startValidationRetentionLoop,
} from './loops.js'
import { makeDeepEnrichActivity } from './modules/deep-enrich/deep-enrich.activity.js'
import { deepEnrich } from './modules/deep-enrich/deep-enrich.service.js'
import type { DeepEnrichDeps } from './modules/deep-enrich/deep-enrich.service.js'

const env = workerEnvFromProcess()

/**
 * Pretty no terminal quando não há arquivo configurado. Com LOG_FILE, mantém
 * JSON em stdout e no arquivo para o Filebeat decodificar os campos fiscais.
 */
const logger = createLogger({
  level: env.logLevel,
  base: { service: 'worker' },
  file: env.logFile,
  pretty: env.logFile === undefined && process.stdout.isTTY === true,
})
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
const s3Configured = hasS3Config(env)
const stopEvidenceAnalysis =
  adminRetentionPool !== null && s3Configured
    ? startEvidenceAnalysisLoop(
        adminRetentionPool.db,
        retentionStore,
        documentAnalyzer,
        env.evidenceAnalysisMaxBytes,
        logger,
      )
    : null
if (stopEvidenceAnalysis === null) {
  if (adminRetentionPool === null) {
    logger.warn(
      { reason: 'EVIDENCE_ANALYSIS_ADMIN_URL_MISSING' },
      'evidence analysis loop disabled: DATABASE_ADMIN_URL not configured',
    )
  }
  if (!s3Configured) {
    logger.warn(
      { reason: 'EVIDENCE_ANALYSIS_S3_MISSING' },
      'evidence analysis loop disabled: S3 settings not configured',
    )
  }
}

// A verificação só depende do banco: lê a análise terminal e materializa a
// observação. Se não houver pool de manutenção, a RLS esconderia as linhas de
// outros tenants, então o loop não sobe.
const stopEvidenceVerification =
  adminRetentionPool !== null ? startEvidenceVerificationLoop(adminRetentionPool.db, logger) : null
if (stopEvidenceVerification === null) {
  logger.warn(
    { reason: 'EVIDENCE_VERIFICATION_ADMIN_URL_MISSING' },
    'evidence verification loop disabled: DATABASE_ADMIN_URL not configured',
  )
}

// Vertical slice F3: consulta fiscal pela referência extraída do comprovante
// (adapter NF3e/SVRS já existente) + reavaliação do claim pelo deep path. O
// scan usa o pool de manutenção; a reavaliação usa o pool do app (RLS), o
// mesmo `deepDeps` da activity do Temporal.
const stopFiscalVerification =
  adminRetentionPool !== null
    ? startFiscalVerificationLoop(
        adminRetentionPool.db,
        makeNf3eFiscalAdapter(),
        (tenantId, validationId) => deepEnrich(deepDeps, { tenantId, validationId }),
        logger,
      )
    : null
if (stopFiscalVerification === null) {
  logger.warn(
    { reason: 'FISCAL_VERIFICATION_ADMIN_URL_MISSING' },
    'fiscal verification loop disabled: DATABASE_ADMIN_URL not configured',
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
  stopEvidenceVerification?.()
  stopFiscalVerification?.()
}
