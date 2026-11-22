import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { createDbPool } from '@comprova/db'
import * as t from '../schemas/index.js'

/**
 * Provisiona (ou atualiza) o usuário superadmin do dashboard administrativo.
 *
 * O Better Auth 1.7 usa scrypt no formato `salt:hash` e localiza a conta de
 * credencial por `account_id = user.id`. Gerar o hash por fora ou gravar o
 * e-mail em `account_id` produz uma conta que nunca autentica. Por isso este
 * script usa o mesmo hasher da biblioteca e mantém a conta no formato dela.
 *
 * Uso:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... DATABASE_ADMIN_URL=... \
 *     pnpm --filter @comprova/db create-admin
 */
const email = process.env.ADMIN_EMAIL
const password = process.env.ADMIN_PASSWORD
const name = process.env.ADMIN_NAME ?? 'Administrador'

if (!email || !password) {
  throw new Error('ADMIN_EMAIL e ADMIN_PASSWORD são obrigatórios')
}
if (password.length < 8) {
  throw new Error('ADMIN_PASSWORD deve ter ao menos 8 caracteres')
}

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL é obrigatório')
}

const pool = createDbPool(adminUrl, { max: 1 })

const ensureAdmin = async (): Promise<string> => {
  const [existing] = await pool.db
    .select({ id: t.adminAuthUser.id })
    .from(t.adminAuthUser)
    .where(eq(t.adminAuthUser.email, email))
    .limit(1)

  if (existing) {
    await pool.db
      .update(t.adminAuthUser)
      .set({ name, role: 'superadmin', emailVerified: true, banned: false, updatedAt: new Date() })
      .where(eq(t.adminAuthUser.id, existing.id))
    return existing.id
  }

  const userId = randomUUID()
  await pool.db.insert(t.adminAuthUser).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    role: 'superadmin',
    banned: false,
  })
  return userId
}

const run = async (): Promise<void> => {
  try {
    const userId = await ensureAdmin()
    const passwordHash = await hashPassword(password)

    const [account] = await pool.db
      .select({ id: t.adminAuthAccount.id })
      .from(t.adminAuthAccount)
      .where(and(eq(t.adminAuthAccount.userId, userId), eq(t.adminAuthAccount.providerId, 'credential')))
      .limit(1)

    if (account) {
      await pool.db
        .update(t.adminAuthAccount)
        .set({ accountId: userId, providerId: 'credential', password: passwordHash, updatedAt: new Date() })
        .where(eq(t.adminAuthAccount.id, account.id))
    } else {
      await pool.db.insert(t.adminAuthAccount).values({
        id: randomUUID(),
        accountId: userId,
        providerId: 'credential',
        userId,
        password: passwordHash,
      })
    }

    console.log(`✅ Superadmin provisionado: ${email}`)
  } finally {
    await pool.end()
  }
}

run().catch((err: unknown) => {
  console.error('❌ Erro ao provisionar admin:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
