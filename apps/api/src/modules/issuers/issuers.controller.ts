import type { KeyObject } from 'node:crypto'
import { ISSUERS_PATH, issuerKeyDocumentOf, type IssuerKeyDocument } from '@comprova/credential'

export interface IssuerControllerDeps {
  /** Origem HTTPS configurada (`CREDENTIAL_ISSUER_ORIGIN`). */
  readonly issuerOrigin: string
  /** Fragmento da chave (`CREDENTIAL_SIGNING_KEY_ID`). */
  readonly keyId: string
  /** Somente a chave PÚBLICA entra no documento; a privada nunca sai do boot. */
  readonly publicKey: KeyObject
}

export const makeIssuerController = (deps: IssuerControllerDeps) => ({
  /**
   * Documento de chave do issuer: reconstrói o `issuer.id` a partir da origem
   * configurada e do escopo recebido e publica o método de verificação. O escopo
   * é opaco (digest do tenant) e a chave é a mesma para toda a origem nesta
   * etapa; nenhum identificador interno é exposto.
   */
  keyDocument: (scope: string): IssuerKeyDocument =>
    issuerKeyDocumentOf(
      { id: `${deps.issuerOrigin}/${ISSUERS_PATH}/${scope}`, keyId: deps.keyId },
      deps.publicKey,
    ),
})
