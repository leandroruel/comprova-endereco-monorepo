import { createDbPool } from '@comprova/db'
import { argon2id } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import * as t from '../src/schemas/index.js'

const ADMIN_EMAIL = 'leandro.ruel@gmail.com'
const ADMIN_PASSWORD = 'AdminComprova2026!'

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required')
}

const pool = createDbPool(adminUrl, { max: 1 })

async function main() {
  // 1. Gerar hash da senha com argon2id (mesmo algoritmo do better-auth)
  const passwordHash = await argon2id.hash(ADMIN_PASSWORD)

  // 2. Inserir o usuário admin na tabela admin_user
  const userId = `admin_${crypto.randomUUID()}`
  await pool.db
    .insert(t.adminAuthUser)
    .values({
      id: userId,
      name: 'Leandro Ruel',
      email: ADMIN_EMAIL,
      emailVerified: true,
      image: null,
      role: 'superadmin',
      banned: false,
      banReason: null,
      banExpires: null,
    })

  // 3. Inserir a conta de senha (argon2 hash) na tabela admin_account
  await pool.db
    .insert(t.adminAuthAccount)
    .values({
      id: `account_${crypto.randomUUID()}`,
      accountId: ADMIN_EMAIL,
      providerId: 'credential',
      userId: userId,
      password: passwordHash,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
    })

  console.log(`✅ Usuário admin criado com sucesso:`)
  console.log(`   Email: ${ADMIN_EMAIL}`)
  console.log(`   Role: superadmin`)
  console.log(`   Senha: ${ADMIN_PASSWORD}`)
  console.log(``)
  console.log(`⚠️  Guarde esta senha. Ela não será exibida novamente.`)

  await pool.end()
}

main().catch((err) => {
  console.error('❌ Erro ao criar admin:', err.message)
  process.exit(1)
})
