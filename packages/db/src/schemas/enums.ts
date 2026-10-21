import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Enums do Postgres, em um único módulo-folha.
 *
 * Ficam juntos porque vários módulos de tabela compartilham o mesmo enum
 * (`doc_type` em subject/batch_item, `val_mode` em validation/batch, `stance_t`
 * em signal/address_signal_cache). Separar por tabela criaria duplicatas.
 */

export const docTypeEnum = pgEnum('doc_type', ['CPF', 'CNPJ'])

export const valModeEnum = pgEnum('val_mode', ['fast', 'deep', 'auto'])

export const valStatusEnum = pgEnum('val_status', [
  'queued',
  'running',
  'partial',
  'completed',
  'failed',
  'expired',
])

export const verdictEnum = pgEnum('verdict_t', [
  'CONFIRMED_COMMERCIAL',
  'SHARED_VIRTUAL',
  'OCCUPIED_BY_OTHER_ENTITY',
  'RESIDENTIAL',
  'NOT_FOUND',
  'FOREIGN',
  'INCONSISTENT',
  'INSUFFICIENT_EVIDENCE',
])

export const stanceEnum = pgEnum('stance_t', ['supports', 'contradicts', 'neutral', 'unknown'])

export const geoPrecisionEnum = pgEnum('geo_precision', [
  'ROOFTOP',
  'RANGE_INTERPOLATED',
  'GEOMETRIC_CENTER',
  'APPROXIMATE',
  'NONE',
])

export const claimTypeEnum = pgEnum('claim_type', ['business_registered_address', 'address_exists'])

export const claimSubjectTypeEnum = pgEnum('claim_subject_type', ['organization', 'person'])

export const claimTargetTypeEnum = pgEnum('claim_target_type', ['address'])

export const evidenceStanceEnum = pgEnum('evidence_stance', ['supports', 'contradicts', 'unknown'])
