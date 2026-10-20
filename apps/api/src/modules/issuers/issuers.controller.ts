import {
  ISSUERS_PATH,
  didDocumentOf,
  didOfIssuer,
  ed25519PublicKeyFromBytes,
  issuerKeyDocumentOf,
  type CredentialStatusDocument,
  type DidDocument,
  type IssuerKeyDocument,
  type IssuerVerificationKey,
} from '@comprova/credential'
import { and, asc, eq, type Db } from '@comprova/db'
import * as t from '@comprova/db'
import { loadPublicCredentialStatus } from '../../services/credential-status.js'
import { signingKeyTrustedCondition } from '../../services/signing-key-lifecycle.js'

export interface IssuerControllerDeps {
  readonly db: Db
  /** Origem HTTPS configurada (`CREDENTIAL_ISSUER_ORIGIN`). */
  readonly issuerOrigin: string
}

export const makeIssuerController = (deps: IssuerControllerDeps) => {
  /**
   * Carrega as chaves PÚBLICAS publicadas e CONFIÁVEIS para o escopo, ordenadas
   * por `key_id`. Apenas `issuer_scope` filtra: uma chave de outro issuer nunca
   * entra. `revoked_at` remove a chave a partir do instante da revogação/
   * expiração (ADR-0029); uma chave apenas rotacionada (`active = false`)
   * continua publicada para verificar credenciais antigas. Devolve `null`
   * quando o escopo não tem chave confiável (o chamador responde 404).
   */
  const publishedMethods = async (scope: string): Promise<IssuerVerificationKey[] | null> => {
    const rows = await deps.db
      .select({ keyId: t.issuerSigningKey.keyId, publicKey: t.issuerSigningKey.publicKey })
      .from(t.issuerSigningKey)
      .where(and(eq(t.issuerSigningKey.issuerScope, scope), signingKeyTrustedCondition()))
      .orderBy(asc(t.issuerSigningKey.keyId))
    if (rows.length === 0) return null
    return rows.map((row) => ({ keyId: row.keyId, publicKey: ed25519PublicKeyFromBytes(row.publicKey) }))
  }

  const issuerUrlOf = (scope: string): string => `${deps.issuerOrigin}/${ISSUERS_PATH}/${scope}`

  return {
    /**
     * Documento de chave do issuer: reconstrói o `issuer.id` a partir da origem
     * configurada e do escopo recebido e publica TODOS os métodos de verificação
     * CONFIÁVEIS registrados para aquele issuer (FASE 14 + ADR-0029). O escopo é
     * opaco (digest do tenant); nenhum identificador interno é exposto, e só a
     * chave PÚBLICA sai daqui.
     *
     * `null` = não há chave confiável para o escopo pedido (o chamador responde
     * 404). Uma credencial de outro issuer nunca é incluída: a seleção é pelo
     * `issuer_scope`.
     */
    keyDocument: async (scope: string): Promise<IssuerKeyDocument | null> => {
      const methods = await publishedMethods(scope)
      if (methods === null) return null
      return issuerKeyDocumentOf(issuerUrlOf(scope), methods)
    },

    /**
     * DID Document do issuer (ADR-0028). O DID é derivado do `issuer.id`
     * (`did:web:<host>:issuers:<escopo>`); o documento é servido em
     * `<issuer.id>/did.json` (resolução `did:web`) e publica os MESMOS métodos
     * públicos que `keyDocument`, com `alsoKnownAs` ligando o DID à URL HTTPS do
     * issuer. `null` = escopo sem chave registrada (404).
     */
    didDocument: async (scope: string): Promise<DidDocument | null> => {
      const methods = await publishedMethods(scope)
      if (methods === null) return null
      const issuerUrl = issuerUrlOf(scope)
      return didDocumentOf(didOfIssuer(issuerUrl), issuerUrl, methods)
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
    credentialStatus: async (
      scope: string,
      credentialId: string,
    ): Promise<CredentialStatusDocument | null> => {
      const status = await loadPublicCredentialStatus(deps.db, scope, credentialId)
      return status === null ? null : { status }
    },
  }
}
