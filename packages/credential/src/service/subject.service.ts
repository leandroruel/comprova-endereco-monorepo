import { createHash } from 'node:crypto'
import { SUBJECTS_PATH } from './issuer.service.js'

/** Entrada da derivação do pseudônimo: o que identifica o subject dentro do tenant. */
export interface SubjectPseudonymInput {
  readonly tenantId: string
  readonly docType: 'CPF' | 'CNPJ'
  readonly docHmac: Uint8Array
}

export interface CredentialSubjectInput extends SubjectPseudonymInput {
  /**
   * URL do issuer (`issuerIdOf`): o subject é identificado no espaço de nomes do
   * seu issuer, como qualquer outro recurso cuja autoridade é o issuer.
   */
  readonly issuerId: string
}

const SUBJECT_ID_DOMAIN = 'comprova:credential-subject:v1'

/**
 * Digest do pseudônimo do subject:
 * `sha256(domínio | tenant_id | doc_type | doc_hmac)` em hex — a MESMA derivação
 * já usada antes da correção do formato do identificador (ADR-0019 §5): só a
 * representação do `credentialSubject.id` mudou, o dígito não.
 */
export const subjectDigestOf = (input: SubjectPseudonymInput): string =>
  createHash('sha256')
    .update(
      `${SUBJECT_ID_DOMAIN}|${input.tenantId}|${input.docType}|${Buffer.from(input.docHmac).toString('hex')}`,
      'utf8',
    )
    .digest('hex')

/**
 * Deriva o identificador público do subject da credencial a partir do
 * pseudônimo interno do tenant (FASE 3).
 *
 * Forma (ADR-0024 §3): `<issuer.id>/subjects/<digest>`, ou seja, uma URL HTTPS
 * na origem configurada do projeto, dentro do namespace do issuer, com o digest
 * do pseudônimo no último segmento — em vez do esquema proprietário
 * `sha256:<digest>`.
 *
 *  - determinístico: mesma entrada → mesmo identificador;
 *  - escopo por issuer: o `tenant_id` entra no digest E no namespace da URL,
 *    evitando correlação entre tenants (o `doc_hmac` sozinho é cego a tenant);
 *  - unidirecional: não expõe `doc_hmac` nem o documento;
 *  - não lê nem altera `subject.doc_hmac` / `subject_id`.
 *
 * A URL NÃO é um endpoint: não há resolução pública de subject (ADR-0024). Ela é
 * só o identificador pseudônimo transportado na credencial, e não é reutilizada
 * como identidade interna.
 */
export const deriveCredentialSubjectId = (input: CredentialSubjectInput): string =>
  `${input.issuerId}/${SUBJECTS_PATH}/${subjectDigestOf(input)}`
