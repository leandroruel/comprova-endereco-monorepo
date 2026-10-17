import { createHash } from 'node:crypto'

export interface CredentialSubjectInput {
  readonly tenantId: string
  readonly docType: 'CPF' | 'CNPJ'
  readonly docHmac: Uint8Array
}

const SUBJECT_ID_DOMAIN = 'comprova:credential-subject:v1'

/**
 * Deriva o identificador público do subject da credencial a partir do
 * pseudônimo interno do tenant (FASE 3).
 *
 * Decisão de design (ver ADR-0019): `sha256(domínio | tenant_id | doc_type |
 * doc_hmac)`, prefixado por `sha256:`.
 *
 *  - determinístico: mesma entrada → mesmo identificador;
 *  - escopo por issuer: inclui `tenant_id`, evitando correlação entre issuers
 *    (o `doc_hmac` sozinho é cego a tenant);
 *  - unidirecional: não expõe `doc_hmac` nem o documento;
 *  - não lê nem altera `subject.doc_hmac` / `subject_id`.
 *
 * O identificador NÃO é reutilizado como identidade interna; é apenas o rótulo
 * pseudônimo transportado na credencial.
 */
export const deriveCredentialSubjectId = (input: CredentialSubjectInput): string => {
  const hmacHex = Buffer.from(input.docHmac).toString('hex')
  const digest = createHash('sha256')
    .update(`${SUBJECT_ID_DOMAIN}|${input.tenantId}|${input.docType}|${hmacHex}`, 'utf8')
    .digest('hex')
  return `sha256:${digest}`
}
