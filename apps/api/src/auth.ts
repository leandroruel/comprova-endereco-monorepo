import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Db } from '@comprova/db'
import * as t from '@comprova/db'

export const createAuth = (db: Db, secret: string) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: {
          model: t.authUser,
          fields: {
            id: 'id',
            name: 'name',
            email: 'email',
            emailVerified: 'email_verified',
            image: 'image',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
          },
        },
        session: {
          model: t.authSession,
          fields: {
            id: 'id',
            expiresAt: 'expires_at',
            token: 'token',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            ipAddress: 'ip_address',
            userAgent: 'user_agent',
            userId: 'user_id',
          },
        },
        account: {
          model: t.authAccount,
          fields: {
            id: 'id',
            accountId: 'account_id',
            providerId: 'provider_id',
            userId: 'user_id',
            accessToken: 'access_token',
            refreshToken: 'refresh_token',
            idToken: 'id_token',
            accessTokenExpiresAt: 'access_token_expires_at',
            refreshTokenExpiresAt: 'refresh_token_expires_at',
            scope: 'scope',
            password: 'password',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
          },
        },
      },
    }),
    secret,
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
  })

export type Auth = ReturnType<typeof createAuth>
