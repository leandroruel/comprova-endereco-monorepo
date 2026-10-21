import { z } from 'zod'
import { HexSha256Schema } from './assertion.schema.js'
import { DataIntegrityProofSchema } from './proof.schema.js'
import { CredentialStatusSchema } from './status.schema.js'

/**
 * Documento W3C (VC Data Model 2.0). Este arquivo concentra a FORMA do
 * documento (schemas, tipos e constantes); o mapping do modelo interno da
 * Comprova (`AssertionPayload`) para o documento veriável vive em
 * `service/credential.service.ts`.
 *
 * Não há segunda fonte de verdade: o mapping é derivado, e a assertion interna
 * continua sendo o artefato normalizado do domínio.
 *
 *   AssertionSource → AssertionPayload (interno)
 *                   → VerifiableCredential (W3C)
 *                   → DataIntegrityProof (eddsa-jcs-2022)
 *
 * Terminologia W3C usada, sem invenção:
 *  - `@context`, `type`, `issuer`, `validFrom` (§4.6/§4.9), `validUntil`;
 *  - `id` (§4.4) — URL pública e opaca da credencial;
 *  - `credentialStatus` (§4.9) — apenas a URL/tipo do status; o valor
 *    (`ACTIVE`/`REVOKED`) é obtido pelo verificador nessa URL (ADR-0027);
 *  - `credentialSubject` (§4.8);
 *  - `evidence` (§5.6) — cada evidência tem `id` (opcional) e `type`
 *    (obrigatório);
 *  - `proof` (Data Integrity 1.0 §2.1).
 *
 * Todo `id` do documento é uma URL (§4.4): os identificadores internos são
 * UUIDs e aparecem como `urn:uuid:<uuid>` (o próprio exemplo normativo da spec,
 * e o formato usado no vetor B.3). O domínio continua com UUIDs; a conversão
 * para URL/IRI acontece só neste mapping e é desfeita em `observationOfEvidence`
 * para que o `evidence_set_hash` continue sendo o hash dos UUIDs do domínio.
 * `issuer`, `credentialSubject.id` e `proof.verificationMethod` são URLs HTTPS
 * sob a origem configurada do projeto (`service/issuer.service.ts`), nunca esquemas inventados.
 *
 * Tudo que é específico da Comprova vive no namespace
 * `https://comprova.dev/ns/credentials/v2#`, declarado no `@context` inline.
 * A maioria dos termos usa a forma compacta (`comprova:…`); termos de negócio
 * que não devem carregar o nome do produto, como `assertionAuthority`, são
 * declarados individualmente no mesmo `@context`. Nenhum termo W3C é
 * redefinido nem inventado.
 */

export const VC_CONTEXT_URL = 'https://www.w3.org/ns/credentials/v2'
export const COMPROVA_CONTEXT_URL = 'https://comprova.dev/ns/credentials/v2#'

/**
 * Termos publicados sem o prefixo do produto. O nome do campo descreve o
 * conceito de negócio; o IRI continua no namespace do vocabulário.
 */
export const ASSERTION_AUTHORITY_IRI = `${COMPROVA_CONTEXT_URL}assertionAuthority`
export const SCOPES_IRI = `${COMPROVA_CONTEXT_URL}scopes`

export const VERIFIABLE_CREDENTIAL_TYPE = 'VerifiableCredential'
export const COMPROVA_CREDENTIAL_TYPE = 'comprova:AddressCredential'
export const COMPROVA_SUBJECT_TYPE = 'comprova:AddressSubject'
export const COMPROVA_CLAIM_TYPE = 'comprova:AddressClaim'
export const COMPROVA_EVIDENCE_TYPE = 'comprova:Evidence'

const URN_UUID_PREFIX = 'urn:uuid:'

/**
 * Identificador de recurso no documento: uma URL. O Data Model 2.0 (§4.4) exige
 * que `id` seja uma única URL — um UUID nu é um IRI relativo e não é
 * interoperável —, e a spec exemplifica com `urn:uuid:`.
 */
export type UrnUuid = `urn:uuid:${string}`
export const UrnUuidSchema = z.templateLiteral([URN_UUID_PREFIX, z.uuid()])
export const urnUuidOf = (uuid: string): UrnUuid => `${URN_UUID_PREFIX}${uuid}`
/** Inverso de `urnUuidOf`. O schema acima garante o prefixo na entrada. */
export const uuidOfUrn = (urn: UrnUuid): string => urn.slice(URN_UUID_PREFIX.length)

const ComprovaAddressSchema = z.object({
  id: UrnUuidSchema.optional(),
  'comprova:buildingKey': z.string().min(1).optional(),
})

const ComprovaClaimSchema = z.object({
  id: UrnUuidSchema,
  type: z.array(z.string()).min(1),
  'comprova:claimType': z.enum(['business_registered_address', 'address_exists']),
  'comprova:subjectType': z.enum(['organization', 'person']),
  /** `claim.target_type` do domínio. */
  'comprova:targetType': z.enum(['address']),
  'comprova:address': ComprovaAddressSchema,
})

const ComprovaEvidenceSchema = z.object({
  id: UrnUuidSchema,
  type: z.array(z.string()).min(1),
  'comprova:checker': z.string().min(1),
  'comprova:checkerVersion': z.string().min(1),
  'comprova:stance': z.enum(['supports', 'contradicts', 'unknown']),
  'comprova:strength': z.number(),
  'comprova:confidence': z.number(),
  'comprova:source': z.string().min(1),
  'comprova:observedAt': z.iso.datetime(),
  /** Binding durável (`claim_evidence.evidence_sha256`); nunca `evidence_id`/`s3_uri`. */
  'comprova:evidenceSha256': HexSha256Schema.optional(),
  'comprova:detail': z.unknown(),
})

const ComprovaExplanationSchema = z.object({
  'comprova:code': z.string(),
  'comprova:summary': z.string(),
  'comprova:supportingEvidence': z.array(UrnUuidSchema),
  'comprova:contradictingEvidence': z.array(UrnUuidSchema),
})

const ComprovaResultSchema = z.object({
  'comprova:verdict': z.string().min(1),
  'comprova:score': z.number(),
  'comprova:confidence': z.number(),
  /**
   * `validation.completed_at` (o mesmo instante de `validFrom`). Opcional no
   * schema por tolerância de leitura: o emissor sempre o escreve, mas ele é
   * proveniência descritiva — a verificação temporal usa `validFrom`.
   */
  'comprova:completedAt': z.iso.datetime().optional(),
  'comprova:explanation': ComprovaExplanationSchema.optional(),
})

const ComprovaPolicySchema = z.object({
  'comprova:version': z.string().min(1),
  'comprova:hash': HexSha256Schema,
})

const ComprovaAlgorithmSchema = z.object({
  'comprova:scorerVersion': z.string().min(1),
})

/**
 * Autoridade do ISSUER sob a qual a asserção foi produzida (snapshot da API
 * key), NÃO uma permissão do titular da credencial. A emissão publica somente
 * os scopes de validação; capacidades administrativas (`keys:write`) são
 * filtradas em `assertion.service.ts`. O verificador não usa este campo para
 * autorizar operações.
 *
 * O nome é semanticamente fechado: `assertionAuthority` descreve a autoridade
 * da asserção, sem repetir o nome do produto e sem sugerir uma capacidade do
 * titular.
 */
const AssertionAuthoritySchema = z.object({
  scopes: z.array(z.string()),
})

/**
 * Forma legada, aceita apenas para LEITURA de documentos já emitidos com
 * `comprova:authorization`. Novas emissões usam `assertionAuthority`.
 *
 * @deprecated Compatibilidade de leitura; não emitir.
 */
const LegacyComprovaAuthorizationSchema = z.object({
  'comprova:scopes': z.array(z.string()),
})

/** Item de `@context`: uma URL (string) ou um contexto JSON-LD inline (objeto). */
const ContextEntrySchema = z.union([z.string(), z.record(z.string(), z.unknown())])

export const VerifiableCredentialSchema = z.object({
  '@context': z.array(ContextEntrySchema).min(1),
  type: z.array(z.string()).min(1),
  /**
   * URL pública da credencial: `<issuer.id>/credentials/<credentialId>`.
   * Opcional no schema por compatibilidade de LEITURA com documentos legados;
   * o emissor sempre o escreve. O verificador com resolução exige o status
   * mesmo quando o documento não o tem (fail closed, ADR-0027).
   */
  id: z.string().min(1).optional(),
  issuer: z.string().min(1),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime().optional(),
  /**
   * Ponteiro para o status público. O valor do status não está aqui — só a URL
   * assinada e o tipo. Alterar a URL depois da assinatura invalida a prova.
   */
  credentialStatus: CredentialStatusSchema.optional(),
  credentialSubject: z.object({
    id: z.string().min(1),
    type: z.array(z.string()).min(1),
    'comprova:docType': z.enum(['CPF', 'CNPJ']),
    'comprova:claim': ComprovaClaimSchema,
  }),
  evidence: z.array(ComprovaEvidenceSchema).min(1),
  'comprova:evidenceSetHash': HexSha256Schema,
  'comprova:result': ComprovaResultSchema,
  'comprova:policy': ComprovaPolicySchema,
  'comprova:algorithm': ComprovaAlgorithmSchema,
  /**
   * Snapshot da autoridade de validação do issuer. Fica fora de
   * `credentialSubject` de propósito: não é uma permissão do titular.
   */
  assertionAuthority: AssertionAuthoritySchema.optional(),
  /** @deprecated Forma legada; aceita somente para verificação. */
  'comprova:authorization': LegacyComprovaAuthorizationSchema.optional(),
  'comprova:legalBasis': z.string().min(1),
})

export type VerifiableCredential = z.infer<typeof VerifiableCredentialSchema>
export type ComprovaEvidence = z.infer<typeof ComprovaEvidenceSchema>

export const SecuredVerifiableCredentialSchema = VerifiableCredentialSchema.extend({
  proof: DataIntegrityProofSchema,
})

export type SecuredVerifiableCredential = z.infer<typeof SecuredVerifiableCredentialSchema>
