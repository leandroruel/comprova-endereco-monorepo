import { systemClock } from '@comprova/core'
import { createDbPool, type DbPool } from '@comprova/db'
import { createLogger } from '@comprova/observability'
import {
  makeDocumentAnalyzer,
  makeDocumentIntelligenceClient,
  makeNf3eFiscalAdapter,
} from '@comprova/providers'
import { workerEnvFromProcess, type WorkerEnv } from './config.js'
import { buildWorkerContext, hasS3Config, makeObjectStore } from './context.js'
import { runWorkerLifecycle } from './lifecycle.js'
import {
  startEvidenceAnalysisLoop,
  startEvidenceRetentionLoop,
  startEvidenceVerificationLoop,
  startFiscalVerificationLoop,
  startHolderSubmissionProcessingLoop,
  startValidationRetentionLoop,
} from './loops.js'
import { deepEnrich, type DeepEnrichDeps } from './modules/deep-enrich/deep-enrich.service.js'

const LOG_BASE = { service: 'worker' }

const loadEnv = (): WorkerEnv | null => {
  try {
    return workerEnvFromProcess()
  } catch (error) {
    // Sem configuração válida não há recurso iniciado para limpar; registra e
    // encerra com erro (o processo não deve subir pela metade).
    const logger = createLogger({ level: 'error', base: LOG_BASE })
    logger.error(
      {
        error_name: error instanceof Error ? error.name : 'unknown',
        error_message: error instanceof Error ? error.message : String(error),
      },
      'worker failed to start: invalid configuration',
    )
    return null
  }
}

const main = async (): Promise<void> => {
  const env = loadEnv()
  if (env === null) {
    process.exitCode = 1
    return
  }

  /**
   * Pretty no terminal quando não há arquivo configurado. Com LOG_FILE, mantém
   * JSON em stdout e no arquivo para o Filebeat decodificar os campos fiscais.
   */
  const logger = createLogger({
    level: env.logLevel,
    base: LOG_BASE,
    file: env.logFile,
    pretty: env.logFile === undefined && process.stdout.isTTY === true,
  })

  // Pools criados durante o boot. O lifecycle fecha todos depois que os loops
  // param; `Set` evita fechar o mesmo pool duas vezes (admin e retenção podem
  // compartilhar a mesma instância).
  const pools = new Set<DbPool>()
  const closePools = async (): Promise<void> => {
    for (const pool of pools) {
      await pool.end()
    }
  }

  const result = await runWorkerLifecycle({
    logger,
    close: closePools,
    start: (track) => {
      const ctx = buildWorkerContext(env)
      pools.add(ctx.pool)
      if (ctx.referencePool !== null) pools.add(ctx.referencePool)

      // A retenção precisa de privilégio de manutenção (DATABASE_ADMIN_URL):
      // remover `evidence` (sem DELETE para app_user) e varrer o grafo de
      // validações expiradas de todos os tenants (RLS é por tenant). Ver ADR
      // de retenção.
      const adminUrl = process.env.DATABASE_ADMIN_URL
      const adminRetentionPool = adminUrl !== undefined && adminUrl !== '' ? createDbPool(adminUrl) : null
      const retentionPool = adminRetentionPool ?? createDbPool(env.databaseUrl)
      pools.add(retentionPool)
      const retentionStore = makeObjectStore(env)
      track(startEvidenceRetentionLoop(retentionPool.db, retentionStore, logger))
      if (adminRetentionPool !== null) {
        track(startValidationRetentionLoop(adminRetentionPool.db, retentionStore, logger))
      }

      // A análise atravessa tenants (fila global) e por isso usa o pool de
      // manutenção. Sem `DATABASE_ADMIN_URL`, a RLS esconderia as linhas
      // `pending`: o worker avisa e não sobe o loop, em vez de falhar
      // silenciosamente.
      //
      // O analyzer usa a camada textual local (unpdf) como fonte preferencial
      // e o serviço Document Intelligence (Marker) quando a camada local não
      // entrega titular e endereço (complemento/OCR). Sem
      // `DOCUMENT_INTELLIGENCE_URL`, o cliente fica desabilitado e o analyzer
      // opera exatamente como antes (nenhuma chamada externa).
      const documentIntelligence = makeDocumentIntelligenceClient({
        url: env.documentIntelligenceUrl,
        timeoutMs: env.documentIntelligenceTimeoutMs ?? 360_000,
        maxFileSizeMb: env.documentIntelligenceMaxFileSizeMb ?? 30,
        logger,
      })
      const documentAnalyzer = makeDocumentAnalyzer({
        documentIntelligence: documentIntelligence.enabled ? documentIntelligence : null,
      })
      if (documentIntelligence.enabled) {
        logger.info(
          { url: env.documentIntelligenceUrl, timeoutMs: env.documentIntelligenceTimeoutMs },
          'document intelligence (marker) enabled for evidence analysis',
        )
      } else {
        logger.info(
          { reason: 'DOCUMENT_INTELLIGENCE_URL_MISSING' },
          'document intelligence disabled: analyzer uses local text layer only',
        )
      }
      const s3Configured = hasS3Config(env)
      if (adminRetentionPool !== null && s3Configured) {
        track(
          startEvidenceAnalysisLoop(
            adminRetentionPool.db,
            retentionStore,
            documentAnalyzer,
            env.evidenceAnalysisMaxBytes,
            logger,
          ),
        )
      } else {
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

      // A verificação só depende do banco: lê a análise terminal e materializa
      // a observação. Se não houver pool de manutenção, a RLS esconderia as
      // linhas de outros tenants, então o loop não sobe.
      if (adminRetentionPool !== null) {
        track(startEvidenceVerificationLoop(adminRetentionPool.db, logger, ctx.referencePool?.db))
      } else {
        logger.warn(
          { reason: 'EVIDENCE_VERIFICATION_ADMIN_URL_MISSING' },
          'evidence verification loop disabled: DATABASE_ADMIN_URL not configured',
        )
      }

      // Vertical slice F3: consulta fiscal pela referência extraída do
      // comprovante (adapter NF3e/SVRS já existente) + reavaliação
      // determinística do claim. O scan usa o pool de manutenção; a
      // reavaliação usa o pool do app (RLS).
      const deepDeps: DeepEnrichDeps = {
        db: ctx.pool.db,
        t1Checkers: ctx.t1Checkers,
        t2Checkers: ctx.t2Checkers,
        policy: ctx.policy,
        policyHash: ctx.policyHash,
        clock: systemClock,
        signalCache: ctx.signalCache,
      }
      if (adminRetentionPool !== null) {
        track(
          startFiscalVerificationLoop(
            adminRetentionPool.db,
            makeNf3eFiscalAdapter(),
            (tenantId, validationId) => deepEnrich(deepDeps, { tenantId, validationId }),
            logger,
            ctx.referencePool?.db,
          ),
        )
      } else {
        logger.warn(
          { reason: 'FISCAL_VERIFICATION_ADMIN_URL_MISSING' },
          'fiscal verification loop disabled: DATABASE_ADMIN_URL not configured',
        )
      }

      // O loop de processamento de submissões do Holder consome o outbox e
      // processa os documentos de cada submissão concluída. Roda no pool de
      // manutenção porque atravessa tenants.
      if (adminRetentionPool !== null) {
        track(startHolderSubmissionProcessingLoop(adminRetentionPool.db, retentionStore, logger))
      } else {
        logger.warn(
          { reason: 'HOLDER_SUBMISSION_PROCESSING_ADMIN_URL_MISSING' },
          'holder submission processing loop disabled: DATABASE_ADMIN_URL not configured',
        )
      }

      logger.info({ retention: true }, 'worker listening')
    },
  })

  if (result === 'boot_failure') process.exitCode = 1
}

await main()
