import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins/admin'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import {
  adminAuthAccount,
  adminAuthSession,
  adminAuthUser,
  adminAuthVerification,
  type Db,
} from '@comprova/db'

/**
 * Instância do Better Auth dedicada ao dashboard administrativo.
 *
 * Usa tabelas separadas (`admin_user`, `admin_session`, `admin_account`,
 * `admin_verification`) para isolamento total de sessões da instância verifier.
 */
export const createAuthAdmin = (db: Db, secret: string) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: adminAuthUser,
        session: adminAuthSession,
        account: adminAuthAccount,
        verification: adminAuthVerification,
      },
    }),
    secret,
    trustedOrigins: ['http://localhost:5173', 'http://admin.localhost:5173', 'http://localhost:3000'],
    advanced: { cookiePrefix: 'admin-auth' },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    plugins: [admin()],
  })

export type AuthAdmin = ReturnType<typeof createAuthAdmin>
