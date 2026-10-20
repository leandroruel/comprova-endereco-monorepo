import { ed25519PublicKeyBytes, issuerScopeOf } from '@comprova/credential'
import * as t from '@comprova/db'
import type { Db } from '@comprova/db'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'

/**
 * Par de chaves Ed25519 efêmero para a configuração de emissão
 * (`CREDENTIAL_SIGNING_KEYS`). Nenhuma chave privada literal vive no
 * repositório: cada teste cria a sua em memória e a API a lê no boot, como faria
 * com a configuração real.
 */
export interface TestCredentialSigningKey {
  readonly keyId: string
  /** PKCS#8 PEM — o mesmo formato aceito no `private_key_pem` da configuração. */
  readonly privateKeyPkcs8Pem: string
  /** Chave pública correspondente, para publicar em `issuer_signing_key`. */
  readonly publicKey: KeyObject
}

export const createTestCredentialSigningKey = (keyId = 'key-1'): TestCredentialSigningKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    keyId,
    privateKeyPkcs8Pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey,
  }
}

export interface CreateIssuerSigningKeyOptions {
  /** `false` marca a chave como superada (não assina credenciais novas). */
  readonly active?: boolean
  /** Instante de revogação/expiração (ADR-0029); `null`/ausente = confiável. */
  readonly revokedAt?: Date | null
}

/**
 * Registra a chave PÚBLICA do tenant em `issuer_signing_key` (FASE 14). A chave
 * privada fica só no `TestCredentialSigningKey` em memória — exatamente como na
 * configuração real, onde o material privado nunca é persistido.
 */
export const createIssuerSigningKey = async (
  db: Db,
  tenantId: string,
  key: TestCredentialSigningKey,
  opts: CreateIssuerSigningKeyOptions = {},
): Promise<string> => {
  const issuerSigningKeyId = randomUUID()
  await db.insert(t.issuerSigningKey).values({
    issuerSigningKeyId,
    tenantId,
    issuerScope: issuerScopeOf(tenantId),
    keyId: key.keyId,
    algorithm: 'Ed25519',
    publicKey: ed25519PublicKeyBytes(key.publicKey),
    active: opts.active ?? true,
    revokedAt: opts.revokedAt ?? null,
  })
  return issuerSigningKeyId
}

/** Monta o JSON de `CREDENTIAL_SIGNING_KEYS` a partir dos pares de teste. */
export const signingKeysConfig = (
  entries: readonly { readonly tenantId: string; readonly key: TestCredentialSigningKey }[],
): string =>
  JSON.stringify(
    entries.map(({ tenantId, key }) => ({
      tenant_id: tenantId,
      key_id: key.keyId,
      private_key_pem: key.privateKeyPkcs8Pem,
    })),
  )
