# ADR-0019: Camada de emissão de credencial (assertion → bytes canônicos → assinatura)

## Status

Aceito (2026-10-17). **Parcialmente superseded por
[ADR-0020](0020-verifiable-credential-data-model-2.md)**: a forma da credencial,
a canonicalização do material assinado, o envelope de assinatura e a API do
verifier (§1, §2, §3 e §9) foram substituídos pela VC Data Model 2.0 com Data
Integrity `eddsa-jcs-2022`. As decisões §4–§8 continuam em vigor.

## Contexto

A auditoria de prontidão para SSI/VC concluiu que o grafo de domínio
`validation → claim → claim_evidence → signal/evidence` já é a assertion, com
todos os bindings necessários (issuer, autoridade, policy, scorer, digest do
material, digest do conjunto). Não se deve remodelar esse grafo nem antecipar
infraestrutura SSI. Esta é a primeira etapa da camada de emissão: provar, com o
menor código possível, que uma `validation` concluída pode virar uma credencial
assinada e verificável por um processo independente.

Regra mantida: **nenhuma alteração no modelo de domínio existente** (nada de
tabela `assertion`/`credential`/`issuer`/`identity`, event sourcing, hash-chain,
Merkle, blockchain, status list, TSA, wallet ou DID).

## Decisão

### 1. Representação de emissão, não fonte de verdade

Novo pacote puro `@comprova/credential`:

- `AssertionPayload`: snapshot derivado da `validation` persistida, com campos
  obrigatórios e forma fixa (campos ausentes são `null` explícito, nunca
  `undefined` — `canonicalJson` descarta propriedades `undefined`);
- `Credential = { payload, proof }`.

O carregamento do grafo (acesso ao PostgreSQL) fica na fronteira da aplicação:
`apps/api/src/services/credential-issuer.ts` (`loadAssertionSource` /
`issueCredential`). O pacote é puro — não conhece banco. A fonte de verdade
continua sendo `validation → claim → claim_evidence`.

### 2. Canonicalização

`canonicalAssertionBytes(payload)` reutiliza `canonicalJson` do
[ADR-0017](0017-verifiability-bindings.md) — o MESMO canonicalizador do
`evidence_set_hash`, exportado de `packages/core/src/provenance.ts`. Assim o
conjunto de evidências embutido é reproduzível pelo algoritmo que o gerou.
Ordens de objeto são normalizadas recursivamente; antes de montar o payload, as
observações e os arrays de explicação são ordenados por identificador, de modo
que `mesma assertion → mesmos bytes`, independentemente da ordem do SQL.
Nenhuma dependência nova (sem JCS/RFC 8785).

### 3. Assinatura

Ed25519 via `node:crypto` (sem dependência nova). O `Signer` só assina bytes
(`sign(bytes): Promise<Uint8Array>`); `IssuerIdentity` só identifica o issuer. O
material assinado é `utf8(canonicalJson(payload))`; o `proof` fica fora dele:

```json
{ "type": "Ed25519Signature", "key_id": "<issuer key ref>", "signature": "<base64url>" }
```

A chave privada nunca entra no payload. Para o MVP, a chave pública é fornecida
diretamente ao verifier; resolver a chave é responsabilidade da camada de
resolução, não da assertion.

### 4. Issuer

`IssuerIdentity { id, keyId }`, com `id = comprova:issuer:<tenant_id>`. O issuer
é o **tenant**. Não há DID/DID Document/resolução/rotação. `api_key_id` e
`user_id` são identificadores internos e **não** entram na credencial;
`issuer_scopes` é transportado como `authorization.scopes` (snapshot da
autoridade vigente — conceito de domínio já existente, não secreto). Separacão
preservada: `issuer = tenant`, `actor = api_key_id|user_id`,
`authorization = issuer_scopes`.

### 5. Subject

`deriveCredentialSubjectId({ tenantId, docType, docHmac }) =
sha256("comprova:credential-subject:v1|<tenant_id>|<doc_type>|<doc_hmac hex>")`,
prefixado por `sha256:`. É determinístico, tem escopo por issuer (inclui
`tenant_id`, evitando correlação cross-tenant que o `doc_hmac` sozinho
permitiria), é unidirecional (não expõe `doc_hmac`) e **não** lê nem altera
`subject.doc_hmac`/`subject_id`.

### 6. Evidence binding

A credencial carrega `evidence.set_hash` (= `validation.evidence_set_hash`) e as
observações com `evidence_sha256` (durável). **Nunca** `evidence_id`/`s3_uri`. O
verifier recomputa o set hash a partir das observações da própria credencial
(mesmo `evidenceSetHash` do core) e compara. Portanto a credencial continua
verificável após a retenção apagar o material físico.

### 7. Policy, algoritmo e timestamps

`policy.version` + `policy.hash` + `algorithm.scorer_version` são transportados
e assinados (sem registry, sem transformar o YAML em tabela). Timestamps:
`created_at`, `completed_at` (nullable), `expires_at`; `observed_at` por
observação.

### 8. Terminalidade

Só emite para `status = 'completed'` com `verdict`/`score`/`confidence`
presentes. `partial` (`mode = 'partial'`) é recusado: não é distinguível de
forma segura de um estado em execução sem o Temporal. Nada é emitido
silenciosamente para estado não final.

### 9. Verifier independente

`verifyCredential(credential, { publicKey, expectedIssuerId?, expectedKeyId? })`
recebe a credencial como JSON e a chave pública e verifica, sem acessar
PostgreSQL/Redis/Temporal/S3/API: formato, issuer, `key_id`, timestamps,
integridade do conjunto (`evidence_set_hash`) e assinatura. Falhas são
classificadas (`MALFORMED_CREDENTIAL`, `ISSUER_MISMATCH`, `KEY_ID_MISMATCH`,
`INVALID_TIMESTAMP`, `EVIDENCE_SET_MISMATCH`, `INVALID_SIGNATURE`).

## Itens deliberadamente NÃO implementados

DID / DID Document / resolução, VC status list / revogação, TSA/RFC 3161,
wallet, selective disclosure / SD-JWT / BBS+, Merkle tree, blockchain, rotação
de chave, KMS/HSM, registry de issuer/verifier, banco de credenciais, event
sourcing, hash-chain. Nenhuma tabela nova. Nenhuma mudança em `building_key`,
`unit_key`, scoring, checkers, thresholds, hard rules, policy YAML, pipeline
T0/T1/T2, retenção, semântica de `validation` ou `subject.doc_hmac`.

## Consequências

- Existe um caminho determinístico e testado de `validation` concluída →
  payload → bytes canônicos → assinatura → credencial → verificação
  independente, com adulteração detectada em qualquer campo assinado.
- A camada é isolada (`@comprova/credential`) e não acopla domínio a SSI; trocar
  a implementação de issuer/signer por uma futura não altera a construção da
  assertion.
- Pendências para produção SSI (fora de escopo agora): identificador de subject
  por credencial na emissão, resolução de chave pública, revogação/expiração de
  credencial e alinhamento entre a janela da assertion (`expires_at`, +30d) e a
  retenção do material.

## Evolução

O pacote `@comprova/credential` só consome o grafo: não introduz um modelo de
domínio paralelo. Requisitos de SSI que, no futuro, exigirem persistência devem
ser avaliados contra o grafo existente — o snapshot de emissão é derivado, e o
domínio existente permanece a única fonte de verdade.
