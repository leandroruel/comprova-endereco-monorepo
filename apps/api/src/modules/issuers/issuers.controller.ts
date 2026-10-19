import {
  ISSUERS_PATH,
  ed25519PublicKeyFromBytes,
  issuerKeyDocumentOf,
  type CredentialStatusDocument,
  type IssuerKeyDocument,
} from '@comprova/credential'
import { asc, eq, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import { loadPublicCredentialStatus } from '../../services/credential-status.js'

export interface IssuerControllerDeps {
  readonly db: Db
  /** Origem HTTPS configurada (`CREDENTIAL_ISSUER_ORIGIN`). */
  readonly issuerOrigin: string
}

export const makeIssuerController = (deps: IssuerControllerDeps) => ({
  /**
   * Documento de chave do issuer: reconstrói o `issuer.id` a partir da origem
   * configurada e do escopo recebido e publica TODOS os métodos de verificação
   * registrados para aquele issuer (FASE 14). O escopo é opaco (digest do
   * tenant); nenhum identificador interno é exposto, e só a chave PÚBLICA sai
   * daqui.
   *
   * `null` = não há chave registrada para o escopo pedido (o chamador responde
   * 404). Uma credencial de outro issuer nunca é incluída: a seleção é pelo
   * `issuer_scope`.
   */
  keyDocument: async (scope: string): Promise<IssuerKeyDocument | null> => {
    const rows = await deps.db
      .select({ keyId: t.issuerSigningKey.keyId, publicKey: t.issuerSigningKey.publicKey })
      .from(t.issuerSigningKey)
      .where(eq(t.issuerSigningKey.issuerScope, scope))
      .orderBy(asc(t.issuerSigningKey.keyId))
    if (rows.length === 0) return null

    return issuerKeyDocumentOf(
      `${deps.issuerOrigin}/${ISSUERS_PATH}/${scope}`,
      rows.map((row) => ({ keyId: row.keyId, publicKey: ed25519PublicKeyFromBytes(row.publicKey) })),
    )
  },

  /**
   * Status público de uma credencial do issuer: `ACTIVE` ou `REVOKED`. A
   * consulta é por (escopo do issuer, credential_id) e seleciona SOMENTE o
   * status — nenhum tenant_id, subject, documento, evidence ou chave. `null` =
   * credencial desconhecida para esse issuer (o chamador responde 404).
   *
   * A rota é pública por construção (não usa `app_tenant_id()`); a policy
   * `public_status_read` só permite SELECT, e a escrita continua escopada por
   * RLS no endpoint autenticado de revogação.
   */
  credentialStatus: async (scope: string, credentialId: string): Promise<CredentialStatusDocument | null> => {
    const status = await loadPublicCredentialStatus(deps.db, scope, credentialId)
    return status === null ? null : { status }
  },
})
