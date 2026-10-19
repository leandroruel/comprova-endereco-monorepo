import { z } from 'zod'
import { IssuerVerificationMethodSchema } from './issuer.schema.js'

/**
 * DID e DID Document do issuer (ADR-0028).
 *
 * O método é `did:web`: a resolução é HTTP(S) sobre a MESMA origem que o
 * projeto já controla (`CREDENTIAL_ISSUER_ORIGIN`). Não há blockchain, ledger,
 * registry, DIDComm nem serviço externo. O DID é DERIVADO do `issuer.id`
 * existente (`<origem>/issuers/<escopo>`, ADR-0024 §2), de modo que credenciais
 * já emitidas continuam válidas e passam a ter uma identidade resolvível:
 *
 *   issuer.id = https://<host>/issuers/<escopo>
 *   DID       = did:web:<host>:issuers:<escopo>
 *   DID Doc   = https://<host>/issuers/<escopo>/did.json
 *
 * A forma do documento é mínima e não inventa termos: `id`, `alsoKnownAs`,
 * `verificationMethod` (Multikey/`publicKeyMultibase`, a MESMA representação de
 * chave que o issuer já publica) e `assertionMethod`. O `alsoKnownAs` liga o DID
 * à URL HTTPS que a credencial declara em `issuer`, provando que as duas
 * identidades são a mesma entidade; é o que permite ao verificador mapear
 * `proof.verificationMethod` (URL HTTPS) para o método do DID Document.
 */
export const DID_METHOD = 'web'
export const DID_CONTEXT_URL = 'https://www.w3.org/ns/did/v1'

/** O método de verificação do DID usa a MESMA forma Multikey do issuer. */
export const DidVerificationMethodSchema = IssuerVerificationMethodSchema
export type DidVerificationMethod = z.infer<typeof DidVerificationMethodSchema>

/**
 * DID Document mínimo. Não é `.strict()`: um DID Document é extensível por
 * natureza, e campos W3C adicionais (por exemplo `service`) não podem invalidar
 * a resolução. O que importa é que os membros exigidos estejam presentes e
 * coerentes — a checagem de coerência (`id`, `controller`, `alsoKnownAs`,
 * `assertionMethod`) é feita pelo resolver.
 */
export const DidDocumentSchema = z.object({
  '@context': z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).min(1),
  id: z.string().min(1),
  alsoKnownAs: z.array(z.string().min(1)).min(1),
  verificationMethod: z.array(DidVerificationMethodSchema).min(1),
  assertionMethod: z.array(z.string().min(1)).min(1),
})

export type DidDocument = z.infer<typeof DidDocumentSchema>
