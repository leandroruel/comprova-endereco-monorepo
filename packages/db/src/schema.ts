import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet'
  },
})

const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point,4326)'
  },
})

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

export const tenant = pgTable('tenant', {
  tenantId: uuid('tenant_id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  rateLimitRps: integer('rate_limit_rps').notNull().default(50),
  burst: integer('burst').notNull().default(100),
  monthlyQuota: bigint('monthly_quota', { mode: 'number' }),
  dataRegion: text('data_region').notNull().default('sa-east-1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKey = pgTable(
  'api_key',
  {
    apiKeyId: uuid('api_key_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: bytea('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(['validate:read', 'validate:write']),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_key_prefix_uq')
      .on(t.keyPrefix)
      .where(sql`revoked_at IS NULL`),
  ],
)

export const legalBasis = pgTable('legal_basis', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
})

export const refReceitaEstabelecimento = pgTable(
  'ref_receita_estabelecimento',
  {
    cnpjBasico: char('cnpj_basico', { length: 8 }).notNull(),
    cnpjOrdem: char('cnpj_ordem', { length: 4 }).notNull(),
    cnpjDv: char('cnpj_dv', { length: 2 }).notNull(),
    matrizFilial: smallint('matriz_filial').notNull(),
    nomeFantasia: text('nome_fantasia'),
    situacaoCadastral: smallint('situacao_cadastral').notNull(),
    dataSituacao: date('data_situacao', { mode: 'string' }),
    motivoSituacao: smallint('motivo_situacao'),
    dataAbertura: date('data_abertura', { mode: 'string' }),
    cnaePrincipal: char('cnae_principal', { length: 7 }),
    cnaesSecundarios: char('cnaes_secundarios', { length: 7 }).array(),
    tipoLogradouro: text('tipo_logradouro'),
    logradouro: text('logradouro'),
    numero: text('numero'),
    complemento: text('complemento'),
    bairro: text('bairro'),
    cep: char('cep', { length: 8 }),
    uf: char('uf', { length: 2 }),
    municipioReceita: integer('municipio_receita'),
    municipioIbge: integer('municipio_ibge'),
    paisCodigo: integer('pais_codigo'),
    cidadeExterior: text('cidade_exterior'),
    telefone: text('telefone'),
    emailDomain: text('email_domain'),
    buildingKey: bytea('building_key'),
    unitKey: bytea('unit_key'),
    snapshotMonth: date('snapshot_month', { mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.cnpjBasico, t.cnpjOrdem, t.cnpjDv] })],
)

export const refReceitaEmpresa = pgTable('ref_receita_empresa', {
  cnpjBasico: char('cnpj_basico', { length: 8 }).primaryKey(),
  razaoSocial: text('razao_social').notNull(),
  naturezaJuridica: integer('natureza_juridica'),
  capitalSocial: numeric('capital_social', { precision: 18, scale: 2 }),
  porte: smallint('porte'),
  snapshotMonth: date('snapshot_month', { mode: 'string' }).notNull(),
})

export const refReceitaSocio = pgTable(
  'ref_receita_socio',
  {
    cnpjBasico: char('cnpj_basico', { length: 8 }).notNull(),
    tipoSocio: smallint('tipo_socio').notNull(),
    nomeSocio: text('nome_socio'),
    docMascarado: text('doc_mascarado'),
    qualificacao: smallint('qualificacao'),
    dataEntrada: date('data_entrada', { mode: 'string' }),
    partnerKey: bytea('partner_key').notNull(),
    snapshotMonth: date('snapshot_month', { mode: 'string' }).notNull(),
  },
  (t) => [index('idx_socio_cnpj').on(t.cnpjBasico), index('idx_socio_partner').on(t.partnerKey)],
)

export const refReceitaSimples = pgTable('ref_receita_simples', {
  cnpjBasico: char('cnpj_basico', { length: 8 }).primaryKey(),
  opcaoSimples: boolean('opcao_simples'),
  dataOpcaoSimples: date('data_opcao_simples', { mode: 'string' }),
  dataExclusaoSimples: date('data_exclusao_simples', { mode: 'string' }),
  opcaoMei: boolean('opcao_mei'),
  dataOpcaoMei: date('data_opcao_mei', { mode: 'string' }),
  dataExclusaoMei: date('data_exclusao_mei', { mode: 'string' }),
})

export const refCnefeAddress = pgTable('ref_cnefe_address', {
  cnefeId: bigint('cnefe_id', { mode: 'number' }).primaryKey(),
  uf: char('uf', { length: 2 }).notNull(),
  municipioIbge: integer('municipio_ibge').notNull(),
  cep: char('cep', { length: 8 }),
  logradouroNorm: text('logradouro_norm').notNull(),
  numero: text('numero'),
  complementoNorm: text('complemento_norm'),
  especie: smallint('especie'),
  geom: geographyPoint('geom').notNull(),
  censusYear: smallint('census_year').notNull(),
})

export const refCep = pgTable('ref_cep', {
  cep: char('cep', { length: 8 }).primaryKey(),
  uf: char('uf', { length: 2 }).notNull(),
  municipioIbge: integer('municipio_ibge'),
  localidade: text('localidade'),
  bairro: text('bairro'),
  logradouroNorm: text('logradouro_norm'),
  geom: geographyPoint('geom'),
  source: text('source').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const refKnownSharedAddress = pgTable('ref_known_shared_address', {
  buildingKey: bytea('building_key').primaryKey(),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const refReceitaMunicipio = pgTable(
  'ref_receita_municipio',
  {
    codigoReceita: integer('codigo_receita').primaryKey(),
    codigoIbge: integer('codigo_ibge').notNull(),
    nomeNorm: text('nome_norm').notNull(),
    uf: char('uf', { length: 2 }).notNull(),
  },
  (t) => [unique('ref_receita_municipio_nome_uf_uq').on(t.nomeNorm, t.uf)],
)

export const refCnaeDivisaoCategoria = pgTable('ref_cnae_divisao_categoria', {
  divisao: char('divisao', { length: 2 }).primaryKey(),
  categoria: text('categoria').notNull(),
})

export const canonicalAddress = pgTable('canonical_address', {
  addressId: uuid('address_id').primaryKey(),
  buildingKey: bytea('building_key').notNull().unique(),
  countryCode: char('country_code', { length: 2 }).notNull().default('BR'),
  uf: char('uf', { length: 2 }),
  municipioIbge: integer('municipio_ibge'),
  cep: char('cep', { length: 8 }),
  logradouroNorm: text('logradouro_norm'),
  numero: text('numero'),
  bairroNorm: text('bairro_norm'),
  geom: geographyPoint('geom'),
  geoPrecision: geoPrecisionEnum('geo_precision').notNull().default('NONE'),
  geoConsensusM: real('geo_consensus_m'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
})

export const addressProfile = pgTable('address_profile', {
  addressId: uuid('address_id')
    .primaryKey()
    .references(() => canonicalAddress.addressId),
  activeCnpjCount: integer('active_cnpj_count').notNull(),
  activeMatrizCount: integer('active_matriz_count').notNull(),
  distinctCnaeDiv: integer('distinct_cnae_div').notNull(),
  distinctPartnerCount: integer('distinct_partner_count').notNull(),
  topPartnerShare: real('top_partner_share'),
  isKnownShared: boolean('is_known_shared').notNull().default(false),
  sharedKind: text('shared_kind'),
  openedLast12m: integer('opened_last_12m').notNull().default(0),
  computedFromSnapshot: date('computed_from_snapshot', { mode: 'string' }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
})

export const subject = pgTable(
  'subject',
  {
    subjectId: uuid('subject_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    docType: docTypeEnum('doc_type').notNull(),
    docHmac: bytea('doc_hmac').notNull(),
    docEnc: bytea('doc_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('subject_tenant_hmac_uq').on(t.tenantId, t.docType, t.docHmac)],
)

export const validation = pgTable(
  'validation',
  {
    validationId: uuid('validation_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.subjectId),
    addressId: uuid('address_id'),
    mode: valModeEnum('mode').notNull(),
    status: valStatusEnum('status').notNull(),
    verdict: verdictEnum('verdict'),
    score: real('score'),
    confidence: real('confidence'),
    policyVersion: text('policy_version').notNull(),
    legalBasis: text('legal_basis')
      .notNull()
      .references(() => legalBasis.code),
    consentRef: text('consent_ref'),
    idempotencyKey: text('idempotency_key'),
    workflowId: text('workflow_id'),
    explanation: jsonb('explanation').$type<{ summary?: string } | null>(),
    deepContext: jsonb('deep_context').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.validationId, t.createdAt] }),
    index('idx_validation_tenant_time').on(t.tenantId, t.createdAt.desc()),
    index('idx_validation_subject').on(t.subjectId, t.createdAt.desc()),
  ],
)

export const validationIdempotency = pgTable(
  'validation_idempotency',
  {
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    validationId: uuid('validation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.idempotencyKey] })],
)

export const signal = pgTable(
  'signal',
  {
    signalId: uuid('signal_id').notNull(),
    validationId: uuid('validation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    checkerId: text('checker_id').notNull(),
    checkerVersion: text('checker_version').notNull(),
    stance: stanceEnum('stance').notNull(),
    strength: real('strength').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    evidenceId: uuid('evidence_id'),
  },
  (t) => [primaryKey({ columns: [t.signalId, t.createdAt] })],
)

export const addressSignalCache = pgTable('address_signal_cache', {
  addressId: uuid('address_id')
    .notNull()
    .references(() => canonicalAddress.addressId),
  checkerId: text('checker_id').notNull(),
  checkerVersion: text('checker_version').notNull(),
  stance: stanceEnum('stance').notNull(),
  strength: real('strength').notNull(),
  confidence: real('confidence').notNull(),
  source: text('source').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  evidenceId: uuid('evidence_id'),
})

export const evidence = pgTable('evidence', {
  evidenceId: uuid('evidence_id').primaryKey(),
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  s3Uri: text('s3_uri').notNull(),
  sha256: bytea('sha256').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
})

export const outbox = pgTable('outbox', {
  outboxId: bigserial('outbox_id', { mode: 'number' }).primaryKey(),
  aggregate: text('aggregate').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
})

export const webhookEndpoint = pgTable('webhook_endpoint', {
  endpointId: uuid('endpoint_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.tenantId),
  url: text('url').notNull(),
  secretEnc: bytea('secret_enc').notNull(),
  events: text('events').array().notNull(),
  active: boolean('active').notNull().default(true),
})

export const webhookDelivery = pgTable('webhook_delivery', {
  deliveryId: uuid('delivery_id').primaryKey(),
  endpointId: uuid('endpoint_id')
    .notNull()
    .references(() => webhookEndpoint.endpointId),
  validationId: uuid('validation_id').notNull(),
  attempt: integer('attempt').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  status: text('status').notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  eventType: text('event_type').notNull().default(''),
})

export const usageEvent = pgTable('usage_event', {
  tenantId: uuid('tenant_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  units: integer('units').notNull().default(1),
  costMicros: bigint('cost_micros', { mode: 'number' }),
  validationId: uuid('validation_id'),
})

export const auditLog = pgTable('audit_log', {
  auditId: bigserial('audit_id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: inet('ip'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
})

export const batch = pgTable('batch', {
  batchId: uuid('batch_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.tenantId),
  status: text('status').notNull().default('queued'),
  totalItems: integer('total_items').notNull(),
  mode: valModeEnum('mode').notNull(),
  legalBasis: text('legal_basis')
    .notNull()
    .references(() => legalBasis.code),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const batchItem = pgTable(
  'batch_item',
  {
    itemId: uuid('item_id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batch.batchId),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.tenantId),
    position: integer('position').notNull(),
    docType: docTypeEnum('doc_type').notNull(),
    docDigits: text('doc_digits').notNull(),
    status: text('status').notNull().default('pending'),
    validationId: uuid('validation_id'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [unique('batch_item_position_uq').on(t.batchId, t.position)],
)

export const schema = {
  tenant,
  apiKey,
  legalBasis,
  refReceitaEstabelecimento,
  refReceitaEmpresa,
  refReceitaSocio,
  refReceitaSimples,
  refCnefeAddress,
  refCep,
  refKnownSharedAddress,
  refReceitaMunicipio,
  refCnaeDivisaoCategoria,
  canonicalAddress,
  addressProfile,
  subject,
  validation,
  validationIdempotency,
  signal,
  addressSignalCache,
  evidence,
  outbox,
  webhookEndpoint,
  webhookDelivery,
  usageEvent,
  auditLog,
  batch,
  batchItem,
} as const

export type Tenant = typeof tenant.$inferSelect
export type ApiKey = typeof apiKey.$inferSelect
export type Subject = typeof subject.$inferSelect
export type Validation = typeof validation.$inferSelect
export type Signal = typeof signal.$inferSelect
export type AuditLog = typeof auditLog.$inferSelect
