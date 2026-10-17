import { eq } from '@comprova/db'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'
import { withTenant } from '@comprova/db'
import type { CheckContext, Clock, DocKind, Signal } from '@comprova/core'
import { registryRecordFromDeepContext } from './deep-enrich.registry.js'
import type { PriorSignalRow } from './deep-enrich.signals.js'

type ValidationRow = {
  readonly deepContext: Record<string, unknown> | null
  readonly subjectId: string
  readonly addressId: string | null
}

type SubjectRow = { readonly docType: DocKind }

type AddressRow = {
  readonly buildingKey: Uint8Array | null
  readonly countryCode: string
  readonly uf: string | null
  readonly cep: string | null
  readonly municipioIbge: number | null
  readonly logradouroNorm: string | null
  readonly numero: string | null
  readonly bairroNorm: string | null
}

export interface ValidationState {
  readonly validation: ValidationRow
  readonly subject: SubjectRow
  readonly priorSignals: readonly PriorSignalRow[]
  readonly addressRow: AddressRow | undefined
}

const firstOrThrow = <T>(rows: readonly T[], message: string): T => {
  const first = rows[0]
  if (first === undefined) throw new Error(message)
  return first
}

/**
 * Carrega o estado persistido necessário ao deep path. `validation`/`subject`/`signal`
 * passam por `withTenant` (RLS); `canonical_address` é global e é lida direto.
 */
export const loadValidationState = async (
  db: Db,
  tenantId: string,
  validationId: string,
): Promise<ValidationState> => {
  const validation = firstOrThrow(
    await withTenant(db, tenantId, (tx) =>
      tx.select().from(t.validation).where(eq(t.validation.validationId, validationId)).limit(1),
    ),
    `validation ${validationId} not found for tenant`,
  )

  const subject = firstOrThrow(
    await withTenant(db, tenantId, (tx) =>
      tx.select().from(t.subject).where(eq(t.subject.subjectId, validation.subjectId)).limit(1),
    ),
    `subject ${validation.subjectId} not found`,
  )

  const priorSignals = await withTenant(db, tenantId, (tx) =>
    tx.select().from(t.signal).where(eq(t.signal.validationId, validationId)),
  )

  const addressRows =
    validation.addressId === null
      ? []
      : await db
          .select({
            buildingKey: t.canonicalAddress.buildingKey,
            countryCode: t.canonicalAddress.countryCode,
            uf: t.canonicalAddress.uf,
            municipioIbge: t.canonicalAddress.municipioIbge,
            cep: t.canonicalAddress.cep,
            logradouroNorm: t.canonicalAddress.logradouroNorm,
            numero: t.canonicalAddress.numero,
            bairroNorm: t.canonicalAddress.bairroNorm,
          })
          .from(t.canonicalAddress)
          .where(eq(t.canonicalAddress.addressId, validation.addressId))
          .limit(1)

  return { validation, subject, priorSignals, addressRow: addressRows[0] }
}

export interface BuildCheckContextInput {
  readonly validation: ValidationRow
  readonly subject: SubjectRow
  readonly addressRow: AddressRow | undefined
  readonly priorSignals: readonly Signal[]
  readonly clock: Clock
}

export const buildCheckContext = (input: BuildCheckContextInput): CheckContext => {
  const deepRegistry = registryRecordFromDeepContext(input.validation.deepContext ?? null)
  const addressRow = input.addressRow
  return {
    subject: {
      docType: input.subject.docType,
      docDigitsValid: deepRegistry?.docDigitsValid ?? true,
      pseudonymized: true,
    },
    ...(deepRegistry !== null ? { registryRecord: deepRegistry.record } : {}),
    address:
      addressRow === undefined || addressRow.buildingKey === null
        ? null
        : {
            buildingKey: Buffer.from(addressRow.buildingKey),
            country: addressRow.countryCode,
            uf: addressRow.uf ?? undefined,
            cep: addressRow.cep ?? undefined,
            municipioIbge: addressRow.municipioIbge ?? undefined,
            logradouroNorm: addressRow.logradouroNorm ?? undefined,
            numero: addressRow.numero ?? undefined,
            bairroNorm: addressRow.bairroNorm ?? undefined,
          },
    priorSignals: input.priorSignals,
    clock: input.clock,
    metrics: {
      increment: () => undefined,
      observe: () => undefined,
    },
  }
}
