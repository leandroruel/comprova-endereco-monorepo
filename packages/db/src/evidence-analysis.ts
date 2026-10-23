import {
  DOCUMENT_ANALYSIS_CONTRACT_VERSION,
  DOCUMENT_ANALYZER_ID,
  DOCUMENT_ANALYZER_VERSION,
} from '@comprova/core'
import { randomUUID } from 'node:crypto'
import type { DbTx } from './client.js'
import { evidenceAnalysis } from './schemas/evidence-analysis.js'

export interface PendingEvidenceAnalysisInput {
  readonly tenantId: string
  readonly artifactId: string
  readonly now?: Date
}

/**
 * Enfileira a análise F1.2 na MESMA transação do intake. O worker (loop de
 * análise) consome a linha `pending`. O par
 * (`artifact_id`, `analyzer`, `analyzer_version`, `contract_version`) é único:
 * replay/retry do upload não cria uma segunda análise.
 */
export const insertPendingEvidenceAnalysis = async (
  tx: DbTx,
  input: PendingEvidenceAnalysisInput,
): Promise<void> => {
  const now = input.now ?? new Date()
  await tx
    .insert(evidenceAnalysis)
    .values({
      analysisId: randomUUID(),
      tenantId: input.tenantId,
      artifactId: input.artifactId,
      analyzer: DOCUMENT_ANALYZER_ID,
      analyzerVersion: DOCUMENT_ANALYZER_VERSION,
      contractVersion: DOCUMENT_ANALYSIS_CONTRACT_VERSION,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        evidenceAnalysis.artifactId,
        evidenceAnalysis.analyzer,
        evidenceAnalysis.analyzerVersion,
        evidenceAnalysis.contractVersion,
      ],
    })
}
