import { createPublicKey, type KeyObject } from 'node:crypto'
import { KeyIdSchema, ed25519PrivateKeyFromPkcs8Pem, ed25519PublicKeyBytes } from '@comprova/credential'
import { z } from 'zod'

/**
 * Configuração e provisionamento do material de assinatura por tenant +
 * `key_id` (FASE 14). O material pode ser local (`CREDENTIAL_SIGNING_KEYS`, com
 * a privada em segredo externo) ou AWS KMS (só a referência e a pública;
 * ADR-0032). A chave privada NUNCA vive no banco: ela é associada ao registro
 * público de `issuer_signing_key` pela chave (`tenant_id`, `key_id`). Este
 * resolver é a fronteira entre "qual chave este tenant usa" (config) e "qual
 * chave está publicada" (banco).
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

/** Chave local configurada para um par (tenant, `key_id`). */
export interface LocalSigningKeyEntry {
  readonly kind: 'local'
  readonly tenantId: string
  readonly keyId: string
  readonly privateKey: KeyObject
}

/**
 * Chave cujo material privado vive no AWS KMS. O provisionamento/rotação lê a
 * pública com `GetPublicKey` (nunca a privada) e a persiste em
 * `issuer_signing_key.public_key`; a referência canônica (ARN) fica em
 * `kms_key_reference` (ADR-0032).
 */
export interface KmsSigningKeyEntry {
  readonly kind: 'kms'
  readonly tenantId: string
  readonly keyId: string
  readonly kmsKeyReference: string
  /** 32 bytes crus da Ed25519, lidos do KMS antes de publicar. */
  readonly publicKey: Buffer
}

/** Material de uma chave que pode ser provisionada/rotacionada, local ou KMS. */
export type SigningKeyEntry = LocalSigningKeyEntry | KmsSigningKeyEntry

/** Pública correspondente à entrada, sem jamais tocar na privada do KMS. */
export const publicKeyOf = (entry: SigningKeyEntry): Buffer =>
  entry.kind === 'local'
    ? ed25519PublicKeyBytes(createPublicKey(entry.privateKey))
    : Buffer.from(entry.publicKey)

/** Referência externa da entrada (`null` para material local). */
export const kmsKeyReferenceOf = (entry: SigningKeyEntry): string | null =>
  entry.kind === 'kms' ? entry.kmsKeyReference : null

const mapKey = (tenantId: string, keyId: string): string => `${tenantId}\u0000${keyId}`

/**
 * Lê `CREDENTIAL_SIGNING_KEYS` no boot. JSON inválido, entrada duplicada
 * (`tenant_id`+`key_id`), PEM inválida ou chave não-Ed25519 derrubam a API antes
 * de aceitar tráfego (falha fechado). A chave privada fica só no `KeyObject` em
 * memória — nunca é logada, devolvida nem incluída em documento público.
 */
export const parseSigningKeys = (rawJson: string): readonly LocalSigningKeyEntry[] => {
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
      kind: 'local',
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
