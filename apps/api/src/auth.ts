import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'

export const createAuth = (db: Db, secret: string) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: t.authUser,
        session: t.authSession,
        account: t.authAccount,
        verification: t.authVerification,
      },
    }),
    secret,
    trustedOrigins: ['http://localhost:5173', 'http://localhost:3000'],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
  })

export type Auth = ReturnType<typeof createAuth>
