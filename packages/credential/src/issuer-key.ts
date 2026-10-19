import type { KeyObject } from 'node:crypto'
import { z } from 'zod'
import { verificationMethodOf, type IssuerIdentity } from './issuer.js'
import { encodeEd25519PublicKeyMultibase } from './public-key.js'

/**
 * Documento público de chave do issuer (FASE 13): o recurso que torna a
 * `proof.verificationMethod` resolvível por um terceiro — sem banco, sem
 * segredo.
 *
 * Ele NÃO é um DID Document: não há `@context` de DID, `did:` nem resolução de
 * DID. É um recurso Comprova plano servido no próprio `issuer.id`
 * (`GET <issuer.id>`) que lista o(s) método(s) de verificação publicados naquele
 * issuer. Como o ADR-0024 §2 registra, o `id` do issuer já é a URL do documento
 * e o fragmento aponta a chave; aqui só se materializa o `publicKeyMultibase`.
 *
 * O material é público e mínimo: identificador do método, tipo (`Multikey`), o
 * `controller` (o issuer) e a chave pública. Nunca a chave privada, nunca
 * identificadores internos (tenant, api_key, subject).
 */

/** Tipo W3C do método quando a chave é expressa em `publicKeyMultibase`. */
export const MULTIKEY_TYPE = 'Multikey'

export const IssuerVerificationMethodSchema = z.object({
  id: z.string().min(1),
  type: z.literal(MULTIKEY_TYPE),
  controller: z.string().min(1),
  publicKeyMultibase: z.string().min(1),
})

export const IssuerKeyDocumentSchema = z.object({
  id: z.string().min(1),
  verificationMethod: z.array(IssuerVerificationMethodSchema).min(1),
})

export type IssuerVerificationMethod = z.infer<typeof IssuerVerificationMethodSchema>
export type IssuerKeyDocument = z.infer<typeof IssuerKeyDocumentSchema>

/**
 * Materializa o documento do issuer a partir da identidade e da chave pública.
 * Puro: não lê banco nem ambiente. O documento lista somente o método atual
 * (não há rotação de chave nesta etapa).
 */
export const issuerKeyDocumentOf = (issuer: IssuerIdentity, publicKey: KeyObject): IssuerKeyDocument => ({
  id: issuer.id,
  verificationMethod: [
    {
      id: verificationMethodOf(issuer),
      type: MULTIKEY_TYPE,
      controller: issuer.id,
      publicKeyMultibase: encodeEd25519PublicKeyMultibase(publicKey),
    },
  ],
})
