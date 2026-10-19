import { z } from 'zod'

/**
 * Status/revogação da credencial (ADR-0027).
 *
 * O documento assinado NÃO carrega o valor do status — carrega apenas o
 * `credentialStatus.id` (a URL pública do status) e o seu `type`. O valor
 * (`ACTIVE`/`REVOKED`) é obtido depois, pelo verificador, nessa URL. Assim a
 * credencial continua autocontida e a revogação não exige reemití-la.
 *
 * `credentialStatus` é um termo da VC Data Model 2.0. O tipo usado aqui é o
 * IRI compacto do namespace Comprova já declarado no `@context` inline; não há
 * StatusList2021 nem múltiplos tipos de status neste passo.
 */
export const CREDENTIALS_PATH = 'credentials'
export const CREDENTIAL_STATUS_PATH = 'status'
export const CREDENTIAL_STATUS_TYPE = 'comprova:CredentialStatus'

export const CredentialStatusValueSchema = z.enum(['ACTIVE', 'REVOKED'])
export type CredentialStatusValue = z.infer<typeof CredentialStatusValueSchema>

export const CredentialStatusSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal(CREDENTIAL_STATUS_TYPE),
  })
  .strict()

export type CredentialStatus = z.infer<typeof CredentialStatusSchema>

/**
 * Documento público devolvido pelo endpoint de status. Deliberadamente mínimo:
 * só o valor do status, nenhum identificador interno, subject, documento,
 * evidence ou chave. `.strict()` impede que campos extras sejam aceitos pelo
 * verificador.
 */
export const CredentialStatusDocumentSchema = z
  .object({
    status: CredentialStatusValueSchema,
  })
  .strict()

export type CredentialStatusDocument = z.infer<typeof CredentialStatusDocumentSchema>
