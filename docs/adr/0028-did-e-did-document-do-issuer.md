# ADR-0028: Identidade DID do issuer e DID Document

## Status

Aceito (2026-10-19). Dá sequência ao
[ADR-0027](0027-status-e-revogacao-de-credenciais.md) e retoma a direção já
registrada no [ADR-0020](0020-verifiable-credential-data-model-2.md) §3 e no
[ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md) §2: o issuer passa
a ter uma identidade **resolvível** (`did:web`) e um DID Document que publica a
chave usada na assinatura. Não é uma segunda arquitetura de identidade: é uma
camada de resolução sobre o `issuer.id` e o `issuer_signing_key` que já existem.

**Atualizado pelo [ADR-0029](0029-revogacao-e-expiracao-de-chave-de-assinatura.md):**
chaves revogadas/vencidas deixam de ser publicadas no DID Document, e o
verificador falha fechado. A limitação de revogação registrada abaixo foi
fechada.

## Contexto

Até aqui o issuer era identificado por uma URL HTTPS
(`<origem>/issuers/<escopo>`) e a chave pública era publicada em
`GET <issuer.id>` (ADR-0025), com descoberta em
`/.well-known/comprova-issuer/<escopo>`. O verificador já resolvia a chave por
HTTP, mas o identificador do issuer **não era um DID** e não havia DID Document.

O próximo passo mínimo do roadmap é:

```text
Credential
    │
    ▼
issuer (URL HTTPS) ──deriva──► DID
                                │
                                ▼
                          DID Document
                                │
                                ├── verificationMethod  (chave pública)
                                └── assertionMethod
```

A credencial já emitida precisa continuar verificável. O DID não pode expor
`tenant_id`, subject, CPF/CNPJ, `doc_hmac` nem `validation_id`.

## Decisão

### 1. Método e derivação do DID

O método é **`did:web`** — resolução HTTP(S) sobre a origem que o projeto já
controla (`CREDENTIAL_ISSUER_ORIGIN`). Não há blockchain, ledger, registry,
DIDComm, resolução distribuída nem serviço externo. O ADR-0024 §2 já antecipava
`did:web:<host>:issuers:<escopo>`.

```text
issuer.id = https://<host>/issuers/<escopo>
DID       = did:web:<host>:issuers:<escopo>
```

- **determinístico:** mesma origem + mesmo escopo (tenant) → mesmo DID;
- **isolado:** tenants diferentes têm escopos diferentes → DIDs diferentes;
- **sem PII:** o escopo é `base64url(sha256("comprova:issuer:v1" | tenant_id))`
  (ADR-0024 §2); o DID não contém `tenant_id`, `validation_id`, `subject`,
  documento, `doc_hmac` nem chave;
- **porta:** quando a origem tem porta, ela é percent-encoded como `%3A`
  (`did:web:issuer.test%3A8443:issuers:<escopo>`), conforme `did:web`;
- **rotação não muda o DID:** o `key_id` vive no fragmento do método de
  verificação, não no DID.

`didOfIssuer()` é pura e só aceita uma URL de issuer do Comprova
(`<origem>/issuers/<escopo>`, HTTPS, sem query/fragmento/credenciais).

### 2. DID Document

Forma mínima, sem inventar termos W3C:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:<host>:issuers:<escopo>",
  "alsoKnownAs": ["https://<host>/issuers/<escopo>"],
  "verificationMethod": [
    {
      "id": "did:web:<host>:issuers:<escopo>#<keyId>",
      "type": "Multikey",
      "controller": "did:web:<host>:issuers:<escopo>",
      "publicKeyMultibase": "z..."
    }
  ],
  "assertionMethod": ["did:web:<host>:issuers:<escopo>#<keyId>"]
}
```

- `alsoKnownAs` declara que o DID e a URL HTTPS do issuer são a **mesma
  entidade**. É o elo que permite ao verificador mapear o
  `proof.verificationMethod` (URL HTTPS) para o método do DID Document.
- `type: "Multikey"` e `publicKeyMultibase` são a **mesma representação de chave
  que o issuer já publica** (ADR-0024/0025); nenhum formato novo de chave.
- `controller` é o DID, não a URL HTTPS.
- `verificationMethod` e `assertionMethod` listam **todas** as chaves publicadas
  e **confiáveis** para o escopo, preservando a rotação: a credencial antiga
  aponta `#key-1`, a nova `#key-2`, ambas resolvíveis. Uma chave `active = false`
  continua publicada para verificar o que assinou enquanto estava ativa; ela
  apenas não assina credenciais novas (ADR-0026). A chave com `revoked_at` no
  passado (ou no futuro, a partir do instante) **não** é publicada e o
  verificador falha fechado (ADR-0029).
- O documento é extensível (não é `.strict()`), mas os membros acima e a
  coerência entre eles são obrigatórios na resolução.

### 3. `issuer_signing_key` → `verificationMethod`

Não há tabela nova. `issuer_signing_key` continua sendo a fonte de verdade das
chaves; nenhuma migration é necessária. O endpoint público consulta as linhas
pelo `issuer_scope` (a policy `public_key_read` já permite SELECT público) e
projeta cada chave em um `verificationMethod`:

```text
issuer_signing_key(issuer_scope, key_id, public_key, active)
        │
        ▼
verificationMethod.id = <did>#<key_id>
controller            = <did>
publicKeyMultibase    = multibase(ed25519-pub || public_key)
```

O provisionamento, a geração de chaves, a seleção da chave ativa e a assinatura
**não mudaram**.

### 4. Resolução pública

O endpoint canônico do DID Document é o que o método `did:web` define para um
DID com path:

```text
did:web:<host>:issuers:<escopo>
        │
        ▼
GET https://<host>/issuers/<escopo>/did.json
```

No projeto, isso é a rota pública:

```text
GET /issuers/:scope/did.json
```

- fora de `/v1`, **sem API key**;
- `200` com o DID Document; `404` para escopo sem chave registrada/confiável;
- só material público (chave em `publicKeyMultibase`, `alsoKnownAs`);
- nenhum `tenant_id`, subject, documento, `doc_hmac`, validation ou chave
  privada.

**`/.well-known/did.json` não é usado.** Ele corresponde ao DID raiz
`did:web:<host>`, que não é a identidade de um tenant. Para um DID com path, a
resolução correta de `did:web` é `<host>/<path>/did.json`; adicionar o caminho
bem-conhecido serviria outra identidade (a origem), não o issuer. O endpoint de
chave existente (`GET /issuers/:scope` e
`GET /.well-known/comprova-issuer/:scope`) **permanece** e continua sendo o
documento de chave anterior; o DID Document é adicional.

### 5. Verificador

O verificador não ganhou dependência de banco, Redis, S3, Temporal ou chave
privada. A resolução do DID Document é mais uma implementação do mesmo seam
`VerificationMethodResolver` já usado por `verifyCredentialFromIssuer`:

```text
verifyCredentialFromIssuer(credential, makeHttpDidResolver(...))
        │
        ├── valida a forma e o vínculo verificationMethod ↔ issuer
        ├── deriva o DID do issuer
        ├── GET <issuer.id>/did.json  (allowlist, HTTPS, sem redirect)
        ├── valida id, @context, alsoKnownAs e assertionMethod
        ├── localiza verificationMethod e decodifica publicKeyMultibase
        └── verifyCredentialIntegrity (assinatura + bindings)
```

`makeHttpDidResolver` devolve o **id original** do método
(`<issuer.id>#<keyId>`, HTTPS), então o binding exato de
`verifyCredentialIntegrity` (`verificationMethod === trusted.id`) continua valendo. O
`makeHttpIssuerResolver` existente **não foi substituído**; o DID é uma segunda
forma de resolver a mesma chave, plugável no mesmo ponto.

### 6. Compatibilidade com credenciais existentes

**Nenhum campo da credencial mudou.** `issuer` continua sendo a URL HTTPS e
`proof.verificationMethod` continua sendo `<issuer>#<keyId>`. A relação com o
DID é determinística e verificável:

```text
credential.issuer ──didOfIssuer──► did:web:<host>:issuers:<escopo>
DID Document.alsoKnownAs          ► credential.issuer
DID Document.<did>#<keyId>         ► proof.verificationMethod (fragmento)
```

Assim, uma credencial emitida **antes** deste ADR também pode ser relacionada ao
DID do issuer e à chave que a assinou — desde que o issuer ainda publique a
chave (o que o fluxo de rotação já preserva). Não é necessário suportar dois
formatos de credencial.

**Migração futura (deliberadamente NÃO feita):** trocar o `issuer` da credencial
para o próprio DID (`did:web:...`) e `proof.verificationMethod` para
`<did>#<keyId>` seria uma mudança **incompatível** com os documentos já
emitidos. Se isso for desejado, é uma decisão separada, que exigirá suporte
temporário aos dois formatos e um critério de transição — não uma migração
silenciosa.

### 7. Segurança

- **DID sem dados pessoais:** derivado do escopo opaco; não contém
  `tenant_id`, subject, CPF/CNPJ, `doc_hmac` nem `validation_id`.
- **Isolamento:** a consulta é por `issuer_scope`; o DID Document de A não lista
  a chave (nem o escopo) de B.
- **Vínculo explícito:** o resolver exige `document.id` igual ao DID derivado,
  `alsoKnownAs` contendo exatamente a URL HTTPS do issuer, `assertionMethod`
  contendo o método do fragmento, `controller` igual ao DID e a chave
  decodificável.
- **Cross-issuer:** o `verificationMethod` tem de pertencer ao issuer declarado
  antes de qualquer busca; o documento de outro issuer não é aceito.
- **HTTP/SSRF:** HTTPS obrigatório, origem na allowlist, URL derivada do próprio
  DID (`didDocumentUrlOf`), sem query, sem redirect (`redirect: 'error'` e
  checagem de `redirected`), schema estrito do documento e rejeição de JSON
  inválido. Os segmentos do path do DID são validados contra `/`, `\`, `.` e
  `..`.
- **Sem segredo:** o documento carrega só a chave pública; a privada continua
  fora do banco e fora do verificador.

### 8. Relação com status/revogação

O DID Document **não** carrega `credentialStatus`, `ACTIVE`/`REVOKED`, status
list, expiração nem revogação. Essas responsabilidades continuam no ADR-0027 e
no fluxo `verifyCredentialFromIssuer` (`statusResolver`). O DID resolve **quem
assinou e com qual chave**; o status responde **se o veredito ainda vale**. São
eixos separados. A revogação/expiração da **chave** é tratada no ADR-0029 e se
manifesta pela ausência do método no documento.

## Itens deliberadamente NÃO implementados

Rotação/desativação/atualização de DID; DIDComm; blockchain/ledger; wallet, VP,
selective disclosure, SD-JWT, BBS+; KMS/HSM; rotação automática de chaves;
status list; TSA/RFC 3161; Merkle; registry/trust framework/federação;
resolução DID genérica para múltiplos métodos; tabela genérica de identidade,
DID, DID Document ou verification method; mudança do `issuer` da credencial para
o DID.

## Testes

- `packages/credential/src/schema/did.schema.test.ts` — forma do DID Document e
  rejeição de métodos/chaves inválidos.
- `packages/credential/src/service/did.service.test.ts` — determinismo e
  isolamento do DID, ausência de dados internos, `did:web` (porta, path,
  traversal), DID Document, resolução HTTP com allowlist/HTTPS/sem redirect,
  documento adulterado, chave incompatível, cross-issuer e verificação
  ponta a ponta.
- `apps/api/src/credential.int.test.ts` — endpoint público `/did.json`, só
  material público, isolamento entre tenants, fluxo
  credencial → DID → DID Document → chave → `VALID`, e os casos negativos
  (issuer/método de outro tenant, chave diferente, documento adulterado) e
  omissão de chave revogada/vencida (ADR-0029).
