import type { KeyObject } from 'node:crypto'
import { KeyIdSchema, ed25519PrivateKeyFromPkcs8Pem } from '@comprova/credential'
import { z } from 'zod'

/**
 * Resolução do material PRIVADO de assinatura por tenant + `key_id` (FASE 14).
 *
 * A chave privada NÃO vive no banco: ela vem de configuração/segredo externo e é
 * associada ao registro público de `issuer_signing_key` pela chave
 * (`tenant_id`, `key_id`). Este resolver é a fronteira entre "qual chave este
 * tenant usa" (config) e "qual chave está publicada" (banco).
 *
 * Devolver `null` significa "não há material configurado para este
 * tenant/`key_id`" — a emissão falha fechado, jamais cai numa chave global.
 */
export type SigningKeyResolver = (tenantId: string, keyId: string) => KeyObject | null

export class SigningKeyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyConfigError'
  }
}

const SigningKeyEntrySchema = z.object({
  /**
   * Normalizado para minúsculas: `issuerScopeOf` é um digest do **texto** do
   * `tenant_id`, então `ABC…` e `abc…` gerariam escopos diferentes embora o
   * Postgres trate o `uuid` como o mesmo. Sem isso, uma config em maiúsculas
   * publicaria a chave num escopo e o app consultaria outro.
   */
  tenant_id: z.uuid().transform((value) => value.toLowerCase()),
  key_id: KeyIdSchema,
  /** PKCS#8 PEM Ed25519 (o mesmo formato que `openssl genpkey -algorithm ED25519`). */
  private_key_pem: z.string().min(1),
})

const SigningKeysSchema = z.array(SigningKeyEntrySchema)

/** Material privado configurado para um par (tenant, `key_id`). */
export interface SigningKeyEntry {
  readonly tenantId: string
  readonly keyId: string
  readonly privateKey: KeyObject
}

const mapKey = (tenantId: string, keyId: string): string => `${tenantId}\u0000${keyId}`

/**
 * Lê `CREDENTIAL_SIGNING_KEYS` no boot. JSON inválido, entrada duplicada
 * (`tenant_id`+`key_id`), PEM inválida ou chave não-Ed25519 derrubam a API antes
 * de aceitar tráfego (falha fechado). A chave privada fica só no `KeyObject` em
 * memória — nunca é logada, devolvida nem incluída em documento público.
 */
export const parseSigningKeys = (rawJson: string): readonly SigningKeyEntry[] => {
  const parsed = ((): z.infer<typeof SigningKeysSchema> => {
    let json: unknown
    try {
      json = JSON.parse(rawJson)
    } catch (error) {
      throw new SigningKeyConfigError(
        `CREDENTIAL_SIGNING_KEYS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const result = SigningKeysSchema.safeParse(json)
    if (!result.success) {
      throw new SigningKeyConfigError(
        `CREDENTIAL_SIGNING_KEYS is malformed: ${z.prettifyError(result.error)}`,
      )
    }
    return result.data
  })()

  const seen = new Set<string>()
  return parsed.map((entry) => {
    const lookup = mapKey(entry.tenant_id, entry.key_id)
    if (seen.has(lookup)) {
      throw new SigningKeyConfigError(
        `CREDENTIAL_SIGNING_KEYS has a duplicate entry for tenant ${entry.tenant_id} key ${entry.key_id}`,
      )
    }
    seen.add(lookup)
    return {
      tenantId: entry.tenant_id,
      keyId: entry.key_id,
      privateKey: ed25519PrivateKeyFromPkcs8Pem(entry.private_key_pem),
    }
  })
}

/** Resolver `(tenant, key_id) → KeyObject` a partir de `CREDENTIAL_SIGNING_KEYS`. */
export const makeSigningKeyResolver = (rawJson: string): SigningKeyResolver => {
  const keys = new Map(
    parseSigningKeys(rawJson).map((entry) => [mapKey(entry.tenantId, entry.keyId), entry.privateKey]),
  )
  return (tenantId, keyId) => keys.get(mapKey(tenantId, keyId)) ?? null
}
