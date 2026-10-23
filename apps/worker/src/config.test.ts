import { EVIDENCE_ARTIFACT_MAX_BYTES } from '@comprova/db'
import { describe, expect, it } from 'vitest'
import { workerEnvFromProcess } from './config.js'

describe('workerEnvFromProcess', () => {
  it('trata EVIDENCE_ANALYSIS_MAX_BYTES vazio como ausente', () => {
    const env = workerEnvFromProcess({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/comprova',
      EVIDENCE_ANALYSIS_MAX_BYTES: '',
    })

    expect(env.evidenceAnalysisMaxBytes).toBe(EVIDENCE_ARTIFACT_MAX_BYTES)
  })

  it('rejeita EVIDENCE_ANALYSIS_MAX_BYTES acima do limite do artefato', () => {
    expect(() =>
      workerEnvFromProcess({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/comprova',
        EVIDENCE_ANALYSIS_MAX_BYTES: String(EVIDENCE_ARTIFACT_MAX_BYTES + 1),
      }),
    ).toThrow(`EVIDENCE_ANALYSIS_MAX_BYTES must be an integer between 1 and ${EVIDENCE_ARTIFACT_MAX_BYTES}`)
  })
})
