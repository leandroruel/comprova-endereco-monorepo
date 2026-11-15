import {
  CUSTOMER_DOCUMENT_INTAKE_CHECKER,
  CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
  CUSTOMER_DOCUMENT_INTAKE_SOURCE,
  CUSTOMER_DOCUMENT_INTAKE_STATUS,
  UPLOADED_DOCUMENT_SOURCE,
} from '@comprova/core'
import { and, createDbPool, eq, inArray, runMigrations, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { createLogger } from '@comprova/observability'
import { makeDocumentAnalyzer, makeFakeObjectStore, sha256Of } from '@comprova/providers'
import {
  createSubject,
  createTenant,
  createValidation,
  startTestDb,
  TEST_APP_DB_PASSWORD,
} from '@comprova/testing'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeEvidenceTick } from '../../worker/src/modules/evidence-analysis/evidence-analysis.service.js'
import { holderSubmissionProcessingTick } from '../../worker/src/modules/holder-submission-processing/holder-submission-processing.service.js'
import { verifyEvidenceTick } from '../../worker/src/modules/evidence-verification/evidence-verification.service.js'
import { EvidenceIntakeError, uploadEvidence } from '../src/modules/validations/evidence-intake.service.js'

const FIXED_NOW = () => new Date('2026-10-22T12:00:00.000Z')
const MAX_BYTES = 64 * 1024

const db = await startTestDb()
await runMigrations({ adminUrl: db.adminUrl, rolePassword: TEST_APP_DB_PASSWORD })
const adminPool = createDbPool(db.adminUrl)
const appPool = createDbPool(db.appUrl)

const store = makeFakeObjectStore()
const logger = createLogger({ level: 'silent' })
const analyzer = makeDocumentAnalyzer({ now: FIXED_NOW })

afterAll(async () => {
  await appPool.end()
  await adminPool.end()
  await db.stop()
})

const escapePdf = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const pdfWithText = (lines: readonly string[]): Buffer => {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n${lines
    .map((line) => `(${escapePdf(line)}) Tj\n0 -20 Td\n`)
    .join('')}ET`
  const stream = Buffer.from(content, 'latin1')
  const objects: readonly string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let size = chunks[0]?.length ?? 0
  for (const [index, object] of objects.entries()) {
    offsets.push(size)
    const body = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1')
    chunks.push(body)
    size += body.length
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
      'latin1',
    ),
  )
  return Buffer.concat(chunks)
}

const proof = (holder = 'Maria Silva'): Buffer =>
  pdfWithText([
    'CONTA DE ENERGIA',
    `Titular: ${holder}`,
    'Endereço: Rua das Flores, 123, Apto 45',
    'Bairro: Centro',
    'Cidade: São Paulo',
    'UF: SP',
    'CEP: 01001-000',
    'Vencimento: 10/11/2026',
  ])

const tenantOf = (name: string) => createTenant(adminPool.db, { name })

const validationOf = async (tenantId: string): Promise<string> => {
  const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
  return createValidation(adminPool.db, tenantId, subjectId)
}

const validationWithSubjectOf = async (
  tenantId: string,
): Promise<{ subjectId: string; validationId: string }> => {
  const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
  const validationId = await createValidation(adminPool.db, tenantId, subjectId)
  return { subjectId, validationId }
}

type ClaimTypeForTest = 'business_registered_address' | 'address_exists'

const seedClaim = async (
  tenantId: string,
  validationId: string,
  subjectId: string,
  type: ClaimTypeForTest,
  subjectType: 'organization' | 'person' = 'organization',
): Promise<string> => {
  const claimId = randomUUID()
  await adminPool.db.insert(t.claim).values({
    claimId,
    tenantId,
    validationId,
    subjectId,
    type,
    subjectType,
    targetType: 'address',
  })
  return claimId
}

const seedCustomerReceipt = async (tenantId: string, claimId: string): Promise<string> => {
  const claimEvidenceId = randomUUID()
  await adminPool.db.insert(t.claimEvidence).values({
    claimEvidenceId,
    tenantId,
    claimId,
    checker: CUSTOMER_DOCUMENT_INTAKE_CHECKER,
    checkerVersion: CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
    stance: 'unknown',
    strength: 0,
    confidence: 0,
    source: CUSTOMER_DOCUMENT_INTAKE_SOURCE,
    observedAt: FIXED_NOW(),
    ttlSeconds: 3600,
    expiresAt: new Date(FIXED_NOW().getTime() + 3_600_000),
    detail: {},
  })
  return claimEvidenceId
}

const validationDocumentLinksOf = async (validationId: string) =>
  adminPool.db
    .select()
    .from(t.validationCustomerDocument)
    .where(eq(t.validationCustomerDocument.validationId, validationId))

const errorMessagesOf = (error: unknown): string => {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

interface SeedRequestInput {
  readonly tenantId: string
  readonly validationId?: string | null
  readonly documents?: readonly { readonly bytes: Buffer; readonly contentType?: string }[]
}

const seedRequest = async (input: SeedRequestInput) => {
  const holderId = randomUUID()
  await adminPool.db.insert(t.holder).values({
    holderId,
    tenantId: input.tenantId,
    externalReference: `holder-${holderId}`,
    name: 'Maria Silva',
    // Identidade OPERACIONAL do Holder: nunca é comparada com subject.docHmac.
    documentHash: `holder-document-hash-${holderId}`,
    documentType: 'CPF',
  })

  const requestId = randomUUID()
  await adminPool.db.insert(t.holderInformationRequest).values({
    id: requestId,
    tenantId: input.tenantId,
    holderId,
    type: 'documento_complementar',
    purpose: 'Comprovante de residência',
    items: [
      {
        itemId: 'address-proof',
        description: 'Comprovante de residência',
        required: true,
        documentType: 'proof_of_address',
      },
    ],
    state: 'completed',
    completedAt: new Date(),
    validationId: input.validationId ?? null,
    createdBy: 'holder-evidence-test',
  })

  const documents: { readonly documentId: string; readonly storageKey: string }[] = []
  for (const [index, document] of (input.documents ?? []).entries()) {
    const documentId = randomUUID()
    const storageKey = `tenants/${input.tenantId}/holder-requests/${requestId}/${documentId}`
    const contentType = document.contentType ?? 'application/pdf'
    await store.put(storageKey, document.bytes, contentType)
    await adminPool.db.insert(t.holderInformationRequestDocument).values({
      documentId,
      tenantId: input.tenantId,
      holderInformationRequestId: requestId,
      itemId: `address-proof-${index}`,
      uploadState: 'stored',
      storageKey,
      contentType,
      sizeBytes: document.bytes.byteLength,
      sha256: sha256Of(document.bytes),
      originalFilename: `comprovante-${index}.pdf`,
    })
    documents.push({ documentId, storageKey })
  }

  return { requestId, holderId, documents }
}

const enqueue = async (tenantId: string, requestId: string): Promise<number> => {
  const [row] = await adminPool.db
    .insert(t.outbox)
    .values({
      aggregate: 'holder_information_request',
      aggregateId: requestId,
      eventType: 'holder_submission.processing_requested',
      payload: {
        holder_information_request_id: requestId,
        tenant_id: tenantId,
      },
    })
    .returning({ outboxId: t.outbox.outboxId })
  if (row === undefined) throw new Error('failed to enqueue holder submission')
  return row.outboxId
}

const runHolderTick = (now: Date = FIXED_NOW()) =>
  holderSubmissionProcessingTick({ db: adminPool.db, store, logger, now: () => now })

const runAnalysis = () =>
  analyzeEvidenceTick({
    db: adminPool.db,
    store,
    analyzer,
    logger,
    maxBytes: MAX_BYTES,
    batchSize: 10,
  })

const runVerification = () =>
  verifyEvidenceTick({
    db: adminPool.db,
    logger,
    batchSize: 10,
    now: FIXED_NOW,
  })

const graphOf = async (validationId: string) => {
  const claims = await adminPool.db.select().from(t.claim).where(eq(t.claim.validationId, validationId))
  const claimIds = claims.map((claim) => claim.claimId)
  const evidence =
    claimIds.length === 0
      ? []
      : await adminPool.db.select().from(t.claimEvidence).where(inArray(t.claimEvidence.claimId, claimIds))
  const receipt = evidence.find((row) => row.source === CUSTOMER_DOCUMENT_INTAKE_SOURCE)
  const links =
    receipt === undefined
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceArtifactClaimEvidence)
          .where(eq(t.evidenceArtifactClaimEvidence.claimEvidenceId, receipt.claimEvidenceId))
  const artifactIds = links.map((link) => link.artifactId)
  const artifacts =
    artifactIds.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceArtifact)
          .where(inArray(t.evidenceArtifact.artifactId, artifactIds))
  const analyses =
    artifacts.length === 0
      ? []
      : await adminPool.db
          .select()
          .from(t.evidenceAnalysis)
          .where(eq(t.evidenceAnalysis.artifactId, artifacts[0]!.artifactId))
  return { claims, evidence, receipt, links, artifacts, analyses }
}

const countReceipts = async (validationId: string): Promise<number> => {
  const claims = await adminPool.db
    .select({ claimId: t.claim.claimId })
    .from(t.claim)
    .where(eq(t.claim.validationId, validationId))
  if (claims.length === 0) return 0
  const rows = await adminPool.db
    .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
    .from(t.claimEvidence)
    .where(
      and(
        inArray(
          t.claimEvidence.claimId,
          claims.map((claim) => claim.claimId),
        ),
        eq(t.claimEvidence.source, CUSTOMER_DOCUMENT_INTAKE_SOURCE),
      ),
    )
  return rows.length
}

describe('PR #73 — documento do Holder no pipeline de evidências', () => {
  it('materializa recibo pendente, vincula o artefato e permite F1.2 e F1.3', async () => {
    const tenantId = await tenantOf('holder-evidence-main')
    const validationId = await validationOf(tenantId)
    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    const outboxId = await enqueue(tenantId, requestId)

    expect(await runHolderTick()).toBe(1)

    const graph = await graphOf(validationId)
    expect(graph.claims).toHaveLength(1)
    const receipt = graph.receipt
    if (receipt === undefined) throw new Error('customer document receipt missing')
    expect(receipt).toMatchObject({
      source: CUSTOMER_DOCUMENT_INTAKE_SOURCE,
      checker: CUSTOMER_DOCUMENT_INTAKE_CHECKER,
      checkerVersion: CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
      stance: 'unknown',
      strength: 0,
      confidence: 0,
    })
    expect((receipt.detail as { verification: { status: string } }).verification.status).toBe(
      CUSTOMER_DOCUMENT_INTAKE_STATUS,
    )
    expect(
      (receipt.detail as { origin: { holder_information_request_id: string } }).origin
        .holder_information_request_id,
    ).toBe(requestId)

    expect(graph.artifacts).toHaveLength(1)
    expect(graph.artifacts[0]).toMatchObject({
      claimEvidenceId: null,
      holderInformationRequestId: requestId,
    })
    expect(graph.links).toHaveLength(1)
    expect(graph.links[0]!.claimEvidenceId).toBe(receipt.claimEvidenceId)
    expect(graph.links[0]!.artifactId).toBe(graph.artifacts[0]!.artifactId)
    expect(graph.analyses).toHaveLength(1)
    expect(graph.analyses[0]!.status).toBe('pending')

    const outboxRow = await adminPool.db
      .select({ publishedAt: t.outbox.publishedAt })
      .from(t.outbox)
      .where(eq(t.outbox.outboxId, outboxId))
    expect(outboxRow[0]!.publishedAt).not.toBeNull()

    // F1.2 analisa o MESMO artefato vinculado; F1.3 materializa a verificação
    // na Claim sem criar um segundo pipeline.
    await runAnalysis()
    const afterAnalysis = await graphOf(validationId)
    expect(['completed', 'inconclusive', 'unsupported', 'unavailable', 'failed']).toContain(
      afterAnalysis.analyses[0]!.status,
    )

    await runVerification()
    const afterVerification = await graphOf(validationId)
    const verification = afterVerification.evidence.find((row) => row.source === UPLOADED_DOCUMENT_SOURCE)
    expect(verification).toBeDefined()
    expect(verification!.stance).toBe('unknown')
    // O recibo do intake continua pendente e imutável.
    const intakeAfter = afterVerification.evidence.find(
      (row) => row.source === CUSTOMER_DOCUMENT_INTAKE_SOURCE,
    )
    expect(intakeAfter!.claimEvidenceId).toBe(receipt.claimEvidenceId)
  })

  it('mantém 1:1 com uma segunda solicitação para a mesma Validation', async () => {
    const tenantId = await tenantOf('holder-evidence-cardinality')
    const validationId = await validationOf(tenantId)
    const first = await seedRequest({ tenantId, validationId, documents: [{ bytes: proof() }] })
    const second = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof('Outra Pessoa') }],
    })
    await enqueue(tenantId, first.requestId)
    await enqueue(tenantId, second.requestId)

    expect(await runHolderTick()).toBe(2)

    expect(await countReceipts(validationId)).toBe(1)
    const graph = await graphOf(validationId)
    expect(graph.links).toHaveLength(1)
    // O primeiro pedido venceu; o segundo continua sendo documento do Holder.
    expect(graph.artifacts[0]!.holderInformationRequestId).toBe(first.requestId)
    const secondArtifacts = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, second.requestId))
    expect(secondArtifacts.length).toBeGreaterThan(0)
    expect(secondArtifacts.every((row) => row.claimEvidenceId === null)).toBe(true)
  })

  it('é idempotente sob replay do evento e retry do processamento', async () => {
    const tenantId = await tenantOf('holder-evidence-idempotent')
    const validationId = await validationOf(tenantId)
    const { requestId } = await seedRequest({ tenantId, validationId, documents: [{ bytes: proof() }] })
    const outboxId = await enqueue(tenantId, requestId)

    await runHolderTick()
    const first = await graphOf(validationId)

    // Replay: o mesmo evento volta a ficar não publicado e o worker roda de novo.
    await adminPool.db.update(t.outbox).set({ publishedAt: null }).where(eq(t.outbox.outboxId, outboxId))
    await runHolderTick()

    const second = await graphOf(validationId)
    expect(second.receipt!.claimEvidenceId).toBe(first.receipt!.claimEvidenceId)
    expect(second.links).toHaveLength(1)
    expect(second.artifacts).toHaveLength(1)
    expect(second.analyses).toHaveLength(1)
  })

  it('duas execuções concorrentes não violam a cardinalidade', async () => {
    const tenantId = await tenantOf('holder-evidence-concurrent')
    const validationId = await validationOf(tenantId)
    const { requestId } = await seedRequest({ tenantId, validationId, documents: [{ bytes: proof() }] })
    await enqueue(tenantId, requestId)

    await Promise.all([runHolderTick(), runHolderTick()])

    expect(await countReceipts(validationId)).toBe(1)
    const graph = await graphOf(validationId)
    expect(graph.links).toHaveLength(1)
    expect(graph.artifacts).toHaveLength(1)
  })

  it('não compara Holder com Subject e não aprova residência automaticamente', async () => {
    const tenantId = await tenantOf('holder-evidence-identity')
    const subjectId = await createSubject(adminPool.db, tenantId, 'CNPJ')
    const validationId = await createValidation(adminPool.db, tenantId, subjectId)
    const before = await adminPool.db
      .select({ verdict: t.validation.verdict, score: t.validation.score })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    const subjectRows = await adminPool.db
      .select({ docHmac: t.subject.docHmac })
      .from(t.subject)
      .where(eq(t.subject.subjectId, subjectId))

    const { requestId, holderId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof('Titular Diferente do Subject') }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()
    await runAnalysis()
    await runVerification()

    const holderRows = await adminPool.db
      .select({ documentHash: t.holder.documentHash })
      .from(t.holder)
      .where(eq(t.holder.holderId, holderId))
    expect(holderRows[0]!.documentHash).not.toBe(subjectRows[0]!.docHmac.toString('hex'))

    const graph = await graphOf(validationId)
    expect(graph.receipt!.stance).toBe('unknown')
    expect(graph.receipt!.strength).toBe(0)
    expect(graph.receipt!.confidence).toBe(0)
    const receiptDetail = JSON.stringify(graph.receipt!.detail)
    expect(receiptDetail).not.toContain(holderRows[0]!.documentHash)
    expect(receiptDetail).not.toContain(subjectRows[0]!.docHmac.toString('hex'))

    const verification = graph.evidence.find((row) => row.source === UPLOADED_DOCUMENT_SOURCE)
    expect(verification!.stance).toBe('unknown')

    const after = await adminPool.db
      .select({ verdict: t.validation.verdict, score: t.validation.score })
      .from(t.validation)
      .where(eq(t.validation.validationId, validationId))
    expect(after[0]).toEqual(before[0])
  })

  it('solicitação sem vínculo com Validation continua apenas como documento do Holder', async () => {
    const tenantId = await tenantOf('holder-evidence-unlinked')
    const { requestId } = await seedRequest({
      tenantId,
      validationId: null,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)

    await runHolderTick()

    const artifacts = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, requestId))
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.claimEvidenceId).toBeNull()
    const links = await adminPool.db
      .select()
      .from(t.evidenceArtifactClaimEvidence)
      .where(eq(t.evidenceArtifactClaimEvidence.artifactId, artifacts[0]!.artifactId))
    expect(links).toHaveLength(0)
  })

  it('Validation inexistente falha fechado sem materializar artefato, recibo nem vínculo', async () => {
    // A request tem validation_id, mas a Validation não existe: a partir da
    // emenda E7 do ADR-0045 isso NUNCA vira "nunca vinculada" (nenhum artefato
    // com retenção de 30 dias) — o processamento termina em 'failed'.
    const tenantId = await tenantOf('holder-evidence-missing-validation')
    const validationId = randomUUID()
    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)

    await runHolderTick()

    const claims = await adminPool.db.select().from(t.claim).where(eq(t.claim.validationId, validationId))
    expect(claims).toHaveLength(0)
    expect(await countReceipts(validationId)).toBe(0)

    // Falha fechada: nenhum artefato, nenhuma associação no tenant.
    const artifacts = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, requestId))
    expect(artifacts).toHaveLength(0)
    const links = await adminPool.db
      .select()
      .from(t.evidenceArtifactClaimEvidence)
      .where(eq(t.evidenceArtifactClaimEvidence.tenantId, tenantId))
    expect(links).toHaveLength(0)

    // O processamento não é marcado como sucesso.
    const [processingRow] = await adminPool.db
      .select({
        state: t.holderSubmissionProcessing.state,
        lastError: t.holderSubmissionProcessing.lastError,
      })
      .from(t.holderSubmissionProcessing)
      .where(eq(t.holderSubmissionProcessing.holderInformationRequestId, requestId))
    expect(processingRow?.state).toBe('failed')
    expect(processingRow?.lastError).toBe('HOLDER_VALIDATION_REMOVED')
  })

  it('solicitação de outro tenant não é processada nem materializada', async () => {
    const tenantA = await tenantOf('holder-evidence-tenant-a')
    const tenantB = await tenantOf('holder-evidence-tenant-b')
    const validationId = await validationOf(tenantA)
    const { requestId } = await seedRequest({
      tenantId: tenantA,
      validationId,
      documents: [{ bytes: proof() }],
    })

    // Evento adulterado: o payload aponta o tenant B para uma solicitação do A.
    await enqueue(tenantB, requestId)

    await runHolderTick()

    const artifacts = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, requestId))
    expect(artifacts).toHaveLength(0)
    expect(await countReceipts(validationId)).toBe(0)
  })

  it('RLS e constraints continuam efetivas para o vínculo', async () => {
    const tenantA = await tenantOf('holder-evidence-rls-a')
    const tenantB = await tenantOf('holder-evidence-rls-b')
    const validationId = await validationOf(tenantA)
    const { requestId } = await seedRequest({
      tenantId: tenantA,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantA, requestId)
    await runHolderTick()

    const graph = await graphOf(validationId)
    const link = graph.links[0]!

    const visibleToA = await withTenant(appPool.db, tenantA, (tx) =>
      tx
        .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
        .from(t.evidenceArtifactClaimEvidence)
        .where(eq(t.evidenceArtifactClaimEvidence.artifactId, link.artifactId)),
    )
    expect(visibleToA).toHaveLength(1)

    const visibleToB = await withTenant(appPool.db, tenantB, (tx) =>
      tx
        .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
        .from(t.evidenceArtifactClaimEvidence)
        .where(eq(t.evidenceArtifactClaimEvidence.artifactId, link.artifactId)),
    )
    expect(visibleToB).toHaveLength(0)

    // Um segundo vínculo para o mesmo recibo é barrado pelo UNIQUE no banco.
    const second = await seedRequest({
      tenantId: tenantA,
      validationId: null,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantA, second.requestId)
    await runHolderTick()
    const secondArtifacts = await adminPool.db
      .select()
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, second.requestId))
    await expect(
      adminPool.db.insert(t.evidenceArtifactClaimEvidence).values({
        artifactId: secondArtifacts[0]!.artifactId,
        claimEvidenceId: link.claimEvidenceId,
        tenantId: tenantA,
      }),
    ).rejects.toThrow()
  })
})

// Revisão da PR #73: a Claim de endereço é identificada pelo domínio
// (subject.docType), o recibo nunca é reutilizado de outra finalidade e a
// cardinalidade 1:1 Validation ↔ documento é imposta pelo banco.
describe('PR #73 (revisão) — Claim de endereço, cardinalidade por Validation e retenção', () => {
  it('associa o recibo exclusivamente à Claim de endereço quando a Validation tem outras Claims', async () => {
    const tenantId = await tenantOf('holder-evidence-multi-claim')
    const { subjectId, validationId } = await validationWithSubjectOf(tenantId)
    const addressClaimId = await seedClaim(
      tenantId,
      validationId,
      subjectId,
      'business_registered_address',
      'organization',
    )
    const otherClaimId = await seedClaim(tenantId, validationId, subjectId, 'address_exists', 'organization')

    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()

    const graph = await graphOf(validationId)
    const receipt = graph.receipt
    if (receipt === undefined) throw new Error('customer document receipt missing')
    // A Claim canônica de endereço (CNPJ) recebe o recibo.
    expect(receipt.claimId).toBe(addressClaimId)

    // A outra finalidade não recebe evidência nenhuma.
    const otherEvidence = await adminPool.db
      .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, otherClaimId))
    expect(otherEvidence).toHaveLength(0)

    // Relação 1:1 recibo ↔ Validation registrada no banco.
    const links = await validationDocumentLinksOf(validationId)
    expect(links).toHaveLength(1)
    expect(links[0]!.claimEvidenceId).toBe(receipt.claimEvidenceId)
  })

  it('não reutiliza recibo de Claim de outra finalidade nem cria segundo recibo', async () => {
    const tenantId = await tenantOf('holder-evidence-wrong-claim')
    const { subjectId, validationId } = await validationWithSubjectOf(tenantId)
    const addressClaimId = await seedClaim(
      tenantId,
      validationId,
      subjectId,
      'business_registered_address',
      'organization',
    )
    const otherClaimId = await seedClaim(tenantId, validationId, subjectId, 'address_exists', 'organization')
    const legacyReceiptId = await seedCustomerReceipt(tenantId, otherClaimId)

    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()

    // O recibo da finalidade errada permanece o único e não é adotado.
    expect(await countReceipts(validationId)).toBe(1)
    expect(await validationDocumentLinksOf(validationId)).toHaveLength(0)

    // Nenhum recibo novo na Claim de endereço.
    const addressReceipts = await adminPool.db
      .select({ claimEvidenceId: t.claimEvidence.claimEvidenceId })
      .from(t.claimEvidence)
      .where(eq(t.claimEvidence.claimId, addressClaimId))
    expect(addressReceipts).toHaveLength(0)

    // O recibo da outra finalidade não ganhou associação de artefato.
    const associations = await adminPool.db
      .select({ artifactId: t.evidenceArtifactClaimEvidence.artifactId })
      .from(t.evidenceArtifactClaimEvidence)
      .where(eq(t.evidenceArtifactClaimEvidence.claimEvidenceId, legacyReceiptId))
    expect(associations).toHaveLength(0)

    // O documento continua processado no domínio do Holder (artefato + análise).
    const artifacts = await adminPool.db
      .select({ artifactId: t.evidenceArtifact.artifactId })
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, requestId))
    expect(artifacts).toHaveLength(1)
    const processing = await adminPool.db
      .select({ state: t.holderSubmissionProcessing.state })
      .from(t.holderSubmissionProcessing)
      .where(eq(t.holderSubmissionProcessing.holderInformationRequestId, requestId))
    expect(processing[0]?.state).toBe('processed')
  })

  it('adota recibo legado da Claim de endereço criado antes da relação explícita', async () => {
    const tenantId = await tenantOf('holder-evidence-legacy-adopt')
    const { subjectId, validationId } = await validationWithSubjectOf(tenantId)
    const addressClaimId = await seedClaim(
      tenantId,
      validationId,
      subjectId,
      'business_registered_address',
      'organization',
    )
    const legacyReceiptId = await seedCustomerReceipt(tenantId, addressClaimId)

    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()

    // O recibo legado é adotado (vínculo criado), sem criar um segundo recibo.
    expect(await countReceipts(validationId)).toBe(1)
    const links = await validationDocumentLinksOf(validationId)
    expect(links).toHaveLength(1)
    expect(links[0]!.claimEvidenceId).toBe(legacyReceiptId)

    const graph = await graphOf(validationId)
    expect(graph.links).toHaveLength(1)
    expect(graph.links[0]!.claimEvidenceId).toBe(legacyReceiptId)
  })

  it('banco rejeita segundo recibo para a mesma Validation sem deixar registros parciais', async () => {
    const tenantId = await tenantOf('holder-evidence-db-cardinality')
    const { subjectId, validationId } = await validationWithSubjectOf(tenantId)
    await seedClaim(tenantId, validationId, subjectId, 'business_registered_address', 'organization')
    const otherClaimId = await seedClaim(tenantId, validationId, subjectId, 'address_exists', 'organization')

    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()

    expect(await countReceipts(validationId)).toBe(1)
    const before = await validationDocumentLinksOf(validationId)
    expect(before).toHaveLength(1)

    // Escrita bruta fora do fluxo: recibo em outra Claim + vínculo na mesma
    // Validation. A PK de `validation_customer_document` é a barreira.
    const error = await adminPool.db
      .transaction(async (tx) => {
        const receiptId = randomUUID()
        await tx.insert(t.claimEvidence).values({
          claimEvidenceId: receiptId,
          tenantId,
          claimId: otherClaimId,
          checker: CUSTOMER_DOCUMENT_INTAKE_CHECKER,
          checkerVersion: CUSTOMER_DOCUMENT_INTAKE_CHECKER_VERSION,
          stance: 'unknown',
          strength: 0,
          confidence: 0,
          source: CUSTOMER_DOCUMENT_INTAKE_SOURCE,
          observedAt: FIXED_NOW(),
          ttlSeconds: 3600,
          expiresAt: new Date(FIXED_NOW().getTime() + 3_600_000),
          detail: {},
        })
        await tx.insert(t.validationCustomerDocument).values({
          validationId,
          claimEvidenceId: receiptId,
          tenantId,
        })
      })
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect(error).not.toBeNull()
    expect(errorMessagesOf(error)).toContain('validation_customer_document_pkey')

    // Rollback: nenhum recibo parcial e o vínculo original permanece.
    expect(await countReceipts(validationId)).toBe(1)
    expect(await validationDocumentLinksOf(validationId)).toEqual(before)
  })

  it('upload direto F1.1 grava o vínculo recibo ↔ Validation', async () => {
    const tenantId = await tenantOf('holder-evidence-f11-link')
    const { subjectId, validationId } = await validationWithSubjectOf(tenantId)
    // Outra finalidade presente: o upload não pode escolher arbitrariamente.
    const otherClaimId = await seedClaim(tenantId, validationId, subjectId, 'address_exists', 'organization')

    const result = await uploadEvidence(
      { db: adminPool.db, store, logger, maxBytes: MAX_BYTES },
      {
        tenantId,
        validationId,
        data: new Uint8Array(proof()),
        declaredContentType: 'application/pdf',
        idempotencyKey: undefined,
      },
    )

    const receipt = (
      await adminPool.db
        .select()
        .from(t.claimEvidence)
        .where(eq(t.claimEvidence.claimEvidenceId, result.evidenceId))
    )[0]!
    expect(receipt.source).toBe(CUSTOMER_DOCUMENT_INTAKE_SOURCE)
    expect(receipt.claimId).not.toBe(otherClaimId)

    // O recibo caiu na Claim canônica de endereço (CNPJ), não na outra finalidade.
    const receiptClaim = (
      await adminPool.db.select().from(t.claim).where(eq(t.claim.claimId, receipt.claimId))
    )[0]!
    expect(receiptClaim.type).toBe('business_registered_address')
    expect(receiptClaim.subjectType).toBe('organization')

    const links = await validationDocumentLinksOf(validationId)
    expect(links).toHaveLength(1)
    expect(links[0]!.claimEvidenceId).toBe(result.evidenceId)
  })

  it('upload F1.1 após recibo do Holder responde 409 sem criar segunda evidência', async () => {
    const tenantId = await tenantOf('holder-evidence-holder-first')
    const { validationId } = await validationWithSubjectOf(tenantId)
    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof() }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()

    const graph = await graphOf(validationId)
    const holderReceiptId = graph.receipt!.claimEvidenceId

    let caught: unknown = null
    try {
      await uploadEvidence(
        { db: adminPool.db, store, logger, maxBytes: MAX_BYTES },
        {
          tenantId,
          validationId,
          data: new Uint8Array(proof()),
          declaredContentType: 'application/pdf',
          idempotencyKey: undefined,
        },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EvidenceIntakeError)
    expect((caught as EvidenceIntakeError).problem.status).toBe(409)
    expect((caught as EvidenceIntakeError).problem.code).toBe('EVIDENCE_ALREADY_EXISTS')

    // Nada mudou: mesmo recibo, mesmo vínculo, um único documento.
    expect(await countReceipts(validationId)).toBe(1)
    const links = await validationDocumentLinksOf(validationId)
    expect(links).toHaveLength(1)
    expect(links[0]!.claimEvidenceId).toBe(holderReceiptId)
    const artifacts = await adminPool.db
      .select({ artifactId: t.evidenceArtifact.artifactId })
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, requestId))
    expect(artifacts).toHaveLength(1)
  })

  it('worker não cria segundo vínculo quando o recibo já tem artefato direto do F1.1', async () => {
    const tenantId = await tenantOf('holder-evidence-f11-first')
    const { validationId } = await validationWithSubjectOf(tenantId)

    await uploadEvidence(
      { db: adminPool.db, store, logger, maxBytes: MAX_BYTES },
      {
        tenantId,
        validationId,
        data: new Uint8Array(proof()),
        declaredContentType: 'application/pdf',
        idempotencyKey: undefined,
      },
    )
    const linksBefore = await validationDocumentLinksOf(validationId)
    expect(linksBefore).toHaveLength(1)

    const { requestId } = await seedRequest({
      tenantId,
      validationId,
      documents: [{ bytes: proof('Outro Titular') }],
    })
    await enqueue(tenantId, requestId)
    await runHolderTick()

    // Um único recibo e um único vínculo recibo ↔ Validation.
    expect(await countReceipts(validationId)).toBe(1)
    expect(await validationDocumentLinksOf(validationId)).toEqual(linksBefore)

    // O documento do Holder não ganhou associação ao recibo (ele já tem
    // artefato direto) e continua no domínio do Holder.
    const graph = await graphOf(validationId)
    expect(graph.links).toHaveLength(0)
    const holderArtifacts = await adminPool.db
      .select({ artifactId: t.evidenceArtifact.artifactId })
      .from(t.evidenceArtifact)
      .where(eq(t.evidenceArtifact.holderInformationRequestId, requestId))
    expect(holderArtifacts).toHaveLength(1)
  })
})
