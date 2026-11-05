import { and, eq, withTenant } from '@comprova/db'
import * as t from '@comprova/db'
import { randomUUID } from 'node:crypto'
import {
  type HolderDto,
  type KycProcessDto,
  type KycEventDto,
  type KycProcessState,
  type KycEventType,
  type DocumentType,
} from '@comprova/contracts'
import type { Db } from '@comprova/db'

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

const KYC_STATE_TRANSITIONS: Record<KycProcessState, readonly KycProcessState[]> = {
  pending: ['in_progress'],
  in_progress: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
}

const isValidTransition = (fromState: KycProcessState | null, toState: KycProcessState): boolean => {
  if (fromState === null) return toState === 'pending'
  return KYC_STATE_TRANSITIONS[fromState]?.includes(toState) ?? false
}

export const makeHolderService = (deps: { readonly db: Db }) => {
  const { db } = deps

  const createHolder = async (
    actor: string,
    tenantId: string,
    create: {
      readonly externalReference: string
      readonly name: string
      readonly documentHash: string
      readonly documentType: string
    },
  ): Promise<HolderDto> => {
    const existing = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select({ holderId: t.holder.holderId })
        .from(t.holder)
        .where(and(eq(t.holder.tenantId, tenantId), eq(t.holder.externalReference, create.externalReference)))
        .limit(1)
    })

    if (existing.length > 0) {
      throw new AuthorizationError('holder already exists for this external reference')
    }

    const holderId = randomUUID()

    const [inserted] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .insert(t.holder)
        .values({
          holderId,
          tenantId,
          externalReference: create.externalReference,
          name: create.name,
          documentHash: create.documentHash,
          documentType: create.documentType,
        })
        .returning()
    })

    if (!inserted) throw new Error('failed to create holder')

    return {
      holderId: inserted.holderId,
      tenantId: inserted.tenantId,
      externalReference: inserted.externalReference,
      name: inserted.name,
      documentHash: inserted.documentHash,
      documentType: inserted.documentType as unknown as DocumentType,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
    }
  }

  const getHolder = async (actor: string, tenantId: string, holderId: string): Promise<HolderDto | null> => {
    const [holder] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.holder)
        .where(and(eq(t.holder.holderId, holderId), eq(t.holder.tenantId, tenantId)))
        .limit(1)
    })

    if (!holder) return null

    return {
      holderId: holder.holderId,
      tenantId: holder.tenantId,
      externalReference: holder.externalReference,
      name: holder.name,
      documentHash: holder.documentHash,
      documentType: holder.documentType as unknown as DocumentType,
      createdAt: holder.createdAt.toISOString(),
      updatedAt: holder.updatedAt.toISOString(),
    }
  }

  const listHolders = async (
    actor: string,
    tenantId: string,
    opts: { readonly limit: number; readonly offset: number },
  ): Promise<{ holders: HolderDto[]; total: number; limit: number; offset: number }> => {
    const rows = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.holder)
        .where(eq(t.holder.tenantId, tenantId))
        .orderBy(t.holder.createdAt)
        .limit(opts.limit)
        .offset(opts.offset)
    })

    return {
      holders: rows.map((row) => ({
        holderId: row.holderId,
        tenantId: row.tenantId,
        externalReference: row.externalReference,
        name: row.name,
        documentHash: row.documentHash,
        documentType: row.documentType as unknown as DocumentType,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      total: rows.length,
      limit: opts.limit,
      offset: opts.offset,
    }
  }

  const updateHolder = async (
    actor: string,
    tenantId: string,
    holderId: string,
    update: { readonly name?: string; readonly documentHash?: string; readonly documentType?: string },
  ): Promise<HolderDto> => {
    const existing = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.holder)
        .where(and(eq(t.holder.holderId, holderId), eq(t.holder.tenantId, tenantId)))
        .limit(1)
    })

    if (!existing.length) throw new AuthorizationError('holder not found')

    const [updated] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .update(t.holder)
        .set({
          ...(update.name !== undefined ? { name: update.name } : {}),
          ...(update.documentHash !== undefined ? { documentHash: update.documentHash } : {}),
          ...(update.documentType !== undefined ? { documentType: update.documentType } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(t.holder.holderId, holderId), eq(t.holder.tenantId, tenantId)))
        .returning()
    })

    if (!updated) throw new Error('failed to update holder')

    return {
      holderId: updated.holderId,
      tenantId: updated.tenantId,
      externalReference: updated.externalReference,
      name: updated.name,
      documentHash: updated.documentHash,
      documentType: updated.documentType as unknown as DocumentType,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }
  }

  const createKycProcess = async (
    actor: string,
    create: {
      readonly holderId: string
      readonly legalBasis: string
      readonly expiresAt?: string
    },
  ): Promise<KycProcessDto> => {
    const existingHolder = await withTenant(db, create.holderId, async (tx) => {
      return tx
        .select({ holderId: t.holder.holderId })
        .from(t.holder)
        .where(eq(t.holder.holderId, create.holderId))
        .limit(1)
    })

    if (existingHolder.length === 0) throw new AuthorizationError('holder not found')

    const kycProcessId = randomUUID()

    const [inserted] = await withTenant(db, create.holderId, async (tx) => {
      return tx
        .insert(t.kycProcess)
        .values({
          kycProcessId,
          holderId: create.holderId,
          tenantId: create.holderId,
          state: 'pending' as KycProcessState,
          legalBasis: create.legalBasis,
          expiresAt: create.expiresAt ? new Date(create.expiresAt) : null,
        })
        .returning()
    })

    if (!inserted) throw new Error('failed to create KYC process')

    await withTenant(db, create.holderId, async (tx) => {
      await tx.insert(t.kycEvent).values({
        kycEventId: randomUUID(),
        kycProcessId,
        tenantId: create.holderId,
        eventType: 'created' as KycEventType,
        fromState: null,
        toState: 'pending' as KycProcessState,
        actor,
        details: JSON.stringify({ legalBasis: create.legalBasis }),
      })
    })

    return {
      kycProcessId: inserted.kycProcessId,
      holderId: inserted.holderId,
      tenantId: inserted.tenantId,
      state: inserted.state as unknown as KycProcessState,
      legalBasis: inserted.legalBasis,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
      expiresAt: inserted.expiresAt?.toISOString() ?? null,
    }
  }

  const getKycProcess = async (
    actor: string,
    tenantId: string,
    kycProcessId: string,
  ): Promise<KycProcessDto | null> => {
    const [process] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.kycProcess)
        .where(and(eq(t.kycProcess.kycProcessId, kycProcessId), eq(t.kycProcess.tenantId, tenantId)))
        .limit(1)
    })

    if (!process) return null

    return {
      kycProcessId: process.kycProcessId,
      holderId: process.holderId,
      tenantId: process.tenantId,
      state: process.state as unknown as KycProcessState,
      legalBasis: process.legalBasis,
      createdAt: process.createdAt.toISOString(),
      updatedAt: process.updatedAt.toISOString(),
      expiresAt: process.expiresAt?.toISOString() ?? null,
    }
  }

  const listKycProcesses = async (
    actor: string,
    tenantId: string,
    holderId: string,
    opts: { readonly limit: number; readonly offset: number; readonly state?: string },
  ): Promise<{
    processes: KycProcessDto[]
    total: number
    limit: number
    offset: number
  }> => {
    const conditions = [eq(t.kycProcess.holderId, holderId), eq(t.kycProcess.tenantId, tenantId)]

    if (opts.state) conditions.push(eq(t.kycProcess.state, opts.state))

    const rows = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.kycProcess)
        .where(and(...conditions))
        .orderBy(t.kycProcess.createdAt)
        .limit(opts.limit)
        .offset(opts.offset)
    })

    return {
      processes: rows.map((row) => ({
        kycProcessId: row.kycProcessId,
        holderId: row.holderId,
        tenantId: row.tenantId,
        state: row.state as unknown as KycProcessState,
        legalBasis: row.legalBasis,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
      })),
      total: rows.length,
      limit: opts.limit,
      offset: opts.offset,
    }
  }

  const transitionKycProcess = async (
    actor: string,
    tenantId: string,
    kycProcessId: string,
    transition: { readonly toState: KycProcessState; readonly reason?: string },
  ): Promise<KycProcessDto> => {
    const current = await getKycProcess(actor, tenantId, kycProcessId)
    if (!current) throw new AuthorizationError('KYC process not found')

    if (!isValidTransition(current.state as KycProcessState | null, transition.toState)) {
      throw new AuthorizationError(
        `invalid state transition from '${current.state}' to '${transition.toState}'`,
      )
    }

    const now = new Date()
    const [updated] = await withTenant(db, tenantId, async (tx) => {
      return tx
        .update(t.kycProcess)
        .set({ state: transition.toState as KycProcessState, updatedAt: now })
        .where(and(eq(t.kycProcess.kycProcessId, kycProcessId), eq(t.kycProcess.tenantId, tenantId)))
        .returning()
    })

    if (!updated) throw new Error('failed to update KYC process')

    await withTenant(db, tenantId, async (tx) => {
      await tx.insert(t.kycEvent).values({
        kycEventId: randomUUID(),
        kycProcessId,
        tenantId,
        eventType: 'state_transitioned' as KycEventType,
        fromState: current.state as KycProcessState,
        toState: transition.toState,
        actor,
        details: JSON.stringify({ reason: transition.reason }),
      })
    })

    return {
      kycProcessId: updated.kycProcessId,
      holderId: updated.holderId,
      tenantId: updated.tenantId,
      state: updated.state as unknown as KycProcessState,
      legalBasis: updated.legalBasis,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      expiresAt: updated.expiresAt?.toISOString() ?? null,
    }
  }

  const listKycEvents = async (
    actor: string,
    tenantId: string,
    kycProcessId: string,
    opts: { readonly limit: number; readonly offset: number },
  ): Promise<{
    events: KycEventDto[]
    total: number
    limit: number
    offset: number
  }> => {
    const rows = await withTenant(db, tenantId, async (tx) => {
      return tx
        .select()
        .from(t.kycEvent)
        .where(and(eq(t.kycEvent.kycProcessId, kycProcessId), eq(t.kycEvent.tenantId, tenantId)))
        .orderBy(t.kycEvent.createdAt)
        .limit(opts.limit)
        .offset(opts.offset)
    })

    return {
      events: rows.map((row) => ({
        kycEventId: row.kycEventId,
        kycProcessId: row.kycProcessId,
        tenantId: row.tenantId,
        eventType: row.eventType as unknown as KycEventType,
        fromState: row.fromState as unknown as KycProcessState | null,
        toState: row.toState as unknown as KycProcessState,
        actor: row.actor,
        details: row.details as unknown as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      })),
      total: rows.length,
      limit: opts.limit,
      offset: opts.offset,
    }
  }

  return {
    createHolder,
    getHolder,
    listHolders,
    updateHolder,
    createKycProcess,
    getKycProcess,
    listKycProcesses,
    transitionKycProcess,
    listKycEvents,
  }
}
