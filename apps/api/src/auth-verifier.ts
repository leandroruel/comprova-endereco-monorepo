import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import {
  verifierAuthAccount,
  verifierAuthSession,
  verifierAuthUser,
  verifierAuthVerification,
  type Db,
} from '@comprova/db'

/**
 * Instância do Better Auth dedicada ao dashboard do verifier.
 *
 * Usa tabelas separadas (`verifier_user`, `verifier_session`,
 * `verifier_account`, `verifier_verification`) para isolamento total de
 * sessões da instância admin.
 */
export const createAuthVerifier = (db: Db, secret: string) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: verifierAuthUser,
        session: verifierAuthSession,
        account: verifierAuthAccount,
        verification: verifierAuthVerification,
      },
    }),
    secret,
    trustedOrigins: ['http://localhost:5174', 'http://verifier.localhost:5174', 'http://localhost:3000'],
    advanced: { cookiePrefix: 'verifier-auth' },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
  })

export type AuthVerifier = ReturnType<typeof createAuthVerifier>
