import { evidenceSetHash, type EvidenceSetEntry } from '@comprova/core'
import type { CredentialObservation } from './assertion.js'

/**
 * Binding de evidência (FASE 5): converte uma observação da credencial no
 * formato do `evidence_set_hash`. Usa `evidence_sha256` (durável) e NUNCA
 * `evidence_id`/`s3_uri`, de modo que o conjunto continue verificável depois da
 * retenção do material físico.
 */
export const observationEntry = (observation: CredentialObservation): EvidenceSetEntry => ({
  id: observation.id,
  checker: observation.checker,
  checkerVersion: observation.checker_version,
  stance: observation.stance,
  strength: observation.strength,
  confidence: observation.confidence,
  source: observation.source,
  observedAt: observation.observed_at,
  evidenceSha256: observation.evidence_sha256,
  detail: observation.detail,
})

export const evidenceSetHashOfCredential = (observations: readonly CredentialObservation[]): string =>
  evidenceSetHash(observations.map(observationEntry))
