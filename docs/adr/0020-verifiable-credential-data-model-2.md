# ADR-0020: Credencial verificável W3C (VC Data Model 2.0 + Data Integrity EdDSA)

## Status

Aceito (2026-10-17). Substitui, parcialmente, o
[ADR-0019](0019-credential-emission-layer.md): forma da credencial,
canonicalização do material assinado, envelope de assinatura e API do verifier
(§1, §2, §3 e §9). As demais decisões do ADR-0019 (representação derivada, issuer
= tenant, subject derivado, evidence binding, policy/scorer, terminalidade)
continuam válidas.

**Substituído parcialmente pelo
[ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md)**: §2
(`proof.created`), §3 (issuer e `verificationMethod`), §5
(`credentialSubject.id`), §8 (tempo e `validFrom`) e §9 (verifier). Cada seção
afetada abaixo traz a nota correspondente; o restante continua valendo.

## Contexto

O ADR-0019 provou o caminho `validation concluída → snapshot → bytes canônicos →
assinatura → verificação independente`. O artefato emitido, porém, era um
envelope proprietário (`{ payload, proof }` com `Ed25519Signature`), sem
interoperabilidade: nenhum verificador do ecossistema conseguiria consumi-lo.

Esta etapa eleva a **saída** para as normas W3C, mantendo o domínio intocado:

- [VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/);
- [VC Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/);
- [VC Data Integrity EdDSA Cryptosuites 1.0](https://www.w3.org/TR/vc-di-eddsa/).

Restrições preservadas integralmente: `building_key`, `unit_key`, scoring,
checkers, thresholds, hard rules, policy YAML, pipeline T0/T1/T2, retenção,
`subject.subject_id`, `subject.doc_hmac`, schema de `validation` e migrations.
Nenhuma tabela nova, nenhuma segunda representação persistida da assertion.

Escopo preciso do resultado: **W3C Verifiable Credential Data Model 2.0 +
proteção criptográfica Data Integrity**, sem implementar a infraestrutura
completa de identidade descentralizada (DID, resolução, revogação, wallet).

## Decisão

### 1. Três camadas explícitas, um único mapping

```
DB/domínio (validation → claim → claim_evidence → subject)
  │  apps/api/src/services/credential-issuer.ts   (fronteira de leitura + elegibilidade)
  ▼
AssertionSource                                  (formato "plain" de entrada)
  │  packages/credential/src/credential.ts       (normalização; puro)
  ▼
AssertionPayload                                 (assertion INTERNA da Comprova)
  │  packages/credential/src/vc.ts                (mapping; puro)
  ▼
VerifiableCredential                             (documento W3C, sem proof)
  │  packages/credential/src/data-integrity.ts    (eddsa-jcs-2022)
  ▼
SecuredVerifiableCredential                      (VC + proof)
```

- `assertion.ts` continua sendo o modelo **interno**; não foi renomeado para
  parecer W3C.
- `vc.ts` é o **único** módulo que conhece a forma W3C. Ele não persiste nada e
  não é fonte de verdade: é uma função pura de `AssertionPayload`.
- `data-integrity.ts` conhece apenas Data Integrity (documento genérico +
  proof), não conhece a Comprova.
- O domínio não é remodelado; `AssertionPayload` não é "transformado em VC" por
  renomeação de campos — o mapping é explícito e auditável.

### 2. Cryptosuite: `eddsa-jcs-2022` (JCS / RFC 8785)

A especificação de EdDSA define duas suites: `eddsa-rdfc-2022` (JSON-LD +
RDFC-1.0) e `eddsa-jcs-2022` (JCS, RFC 8785). Escolhemos **`eddsa-jcs-2022`**:

- não exige expansão JSON-LD nem canonicalização RDF (nenhuma dependência nova,
  princípio do ADR-0019);
- é determinística sobre o JSON que realmente emitimos;
- o vetor normativo B.3 da própria especificação valida a implementação ponta a
  ponta (canonicalização, hashing, assinatura e Multibase).

`eddsa-rdfc-2022` foi rejeitada: exigiria uma biblioteca de JSON-LD + RDFC-1.0
(superfície de falha e dependência grandes) sem ganho, já que o documento é
gerado por nós e fechado.

**Separação dos dois canonicalizadores:** `canonicalJson` (`@comprova/core`,
ADR-0017) **não** é reutilizado no proof. Ele é o canonicalizador do
`evidence_set_hash` e tem contrato próprio; o JCS exigido pela cryptosuite vive
em `jcs.ts`, isolado na credential layer. `evidence_set_hash` continua
byte-idêntico ao comportamento anterior — os dois contratos não se misturam.

`canonicalJson` foi endurecido na revisão: ele agora **rejeita** números não
finitos (que `JSON.stringify` converteria silenciosamente em `null`, criando
colisão entre `NaN`/`±Infinity` e `null` no hash) e objetos que não são JSON
simples (`Date`, `Map`, `Set`, classes). A serialização de todo valor JSON válido
é idêntica à anterior — nenhum `evidence_set_hash` já persistido muda.

O proof emitido é:

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "created": "<derivado da assertion>",
  "verificationMethod": "comprova:issuer:<tenant_id>#<keyId>",
  "proofPurpose": "assertionMethod",
  "@context": ["<igual ao do documento>"],
  "proofValue": "z<base58btc>"
}
```

Algoritmo implementado fielmente a §3.3.1/§3.3.2:

1. `proofOptions` = opções do proof **sem** `proofValue`;
2. o `@context` do documento é **copiado** para o proof (é o que o vetor B.3
   demonstra e o que permite reconstruir o proof config no verifier);
3. `proofConfig` = JCS(proofOptions); `documento` = JCS(documento **sem** proof);
4. `hashData` = `sha256(proofConfig) || sha256(documento)` (nessa ordem);
5. assinatura Ed25519 pura (RFC 8032) sobre `hashData`;
6. `proofValue` = **multibase base58btc** (`z…`), não mais base64url.

`created` é derivado da assertion (`completed_at ?? created_at`), com
possibilidade de override (`proofCreatedAt`). Não existe timestamp de emissão no
domínio; usar `now()` tornaria a credencial não reproduzível a partir dos mesmos
dados. O `created` reaproveita um instante real da assertion — não inventa um.

> **Atualizado pelo [ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md)
> §4:** `proof.created` passou a ser o instante **real** da criação da prova,
> vindo de um relógio injetável (`now`), nunca de um timestamp da validation.
> Reemitir a mesma validation produz uma **nova prova** com `created` real; o
> documento sem `proof` continua determinístico.

### 3. Issuer e `verificationMethod`

`issuer` continua sendo o **tenant**: `comprova:issuer:<tenant_id>` (string URI,
sem objeto `issuer`, sem DID). `verificationMethod` é
`<issuer.id>#<keyId>`; a chave fica no fragmento, então trocar a identidade por
`did:web:…#<keyId>` numa etapa futura não muda o restante do documento. Ele é
**obrigatório** no proof e o verifier o amarra ao `issuer` declarado (§9): como
não há resolução de chave, o binding é estrutural (`<issuer>#<fragmento não
vazio>`). Não há DID/DID Document/resolução/rotação: a chave pública é injetada
no verifier (ADR-0019 §3). `api_key_id`/`user_id` continuam fora da credencial;
`issuer_scopes` é transportado como `comprova:authorization.scopes`.

> **Atualizado pelo [ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md)
> §2:** `issuer.id` passou a ser `<origem HTTPS>/issuers/<escopo do tenant>`
> (escopo = digest do `tenant_id`, que deixa de aparecer na credencial), sobre uma
> origem configurada e validada (`CREDENTIAL_ISSUER_ORIGIN`) — nenhum domínio é
> presumido. `verificationMethod` continua `<issuer.id>#<keyId>`.

### 4. `@context`, `type` e namespace

```json
"@context": [
  "https://www.w3.org/ns/credentials/v2",
  { "comprova": "https://comprova.dev/ns/credentials/v2#" }
],
"type": ["VerifiableCredential", "comprova:AddressCredential"]
```

- O primeiro item é o contexto base exigido pela VC 2.0.
- O segundo é um contexto **inline** que declara apenas o prefixo `comprova`
  (mesmo domínio já usado em `https://comprova.dev/problems/…`). Não é
  necessário hospedar um documento de contexto: a verificação é JCS, não
  JSON-LD; o contexto serve para dar semântica a consumidores RDF.
- Contextos adicionais são permitidos (Data Model §4.3) e o verifier aceita.
- **Nenhum termo W3C é redefinido ou inventado.** Tudo que é específico da
  Comprova usa IRI compacto `comprova:…`. `evidence` é o termo W3C (§5.6), não
  um campo Comprova.

### 5. `credentialSubject` e o claim de endereço

```json
"credentialSubject": {
  "id": "sha256:<derivado>",
  "type": ["comprova:AddressSubject"],
  "comprova:docType": "CNPJ",
  "comprova:claim": {
    "id": "<claim.id>",
    "type": ["comprova:AddressClaim"],
    "comprova:claimType": "business_registered_address",
    "comprova:subjectType": "organization",
    "comprova:targetType": "address",
    "comprova:address": {
      "id": "<claim.address_id>",
      "comprova:buildingKey": "b64:AAAA"
    }
  }
}
```

| Modelo interno                         | Documento W3C                                           |
| -------------------------------------- | ------------------------------------------------------- |
| `subject.id` (derivado, scoped)        | `credentialSubject.id`                                  |
| `subject.doc_type`                     | `credentialSubject.comprova:docType`                    |
| `claim.id`                             | `credentialSubject.comprova:claim.id`                   |
| `claim.type`                           | `…comprova:claim.comprova:claimType`                    |
| `claim.subject_type`                   | `…comprova:claim.comprova:subjectType`                  |
| `claim.target_type`                    | `…comprova:claim.comprova:targetType`                   |
| `claim.target.id` (`claim.address_id`) | `…comprova:claim.comprova:address.id`                   |
| `claim.target.building_key`            | `…comprova:claim.comprova:address.comprova:buildingKey` |
| `validation.legal_basis`               | `comprova:legalBasis`                                   |

**Todo `id` é uma URL.** O Data Model 2.0 (§4.4) exige que `id` seja uma única
URL — um UUID nu é um IRI relativo e não é interoperável —, e a própria spec
exemplifica com `urn:uuid:` (o mesmo formato do vetor normativo B.3). Assim,
`claim.id`, `claim.target.id` e cada `evidence[].id` são `urn:uuid:<uuid>`. O
domínio continua com UUIDs: a conversão existe só no mapping (`urnUuidOf`) e é
desfeita em `observationOfEvidence` (`uuidOfUrn`), de modo que o
`evidence_set_hash` continue sendo o hash dos UUIDs do domínio.
`credentialSubject.id` permanece o digest `sha256:…` (um IRI válido por si).

> **Atualizado pelo [ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md)
> §3:** `credentialSubject.id` passou a ser
> `<issuer.id>/subjects/<digest>` — uma URL HTTPS no namespace do issuer, com o
> **mesmo digest** de antes no último segmento (o esquema proprietário `sha256:`
> era o problema). Continua determinístico, com escopo por tenant e sem expor
> documento/`doc_hmac`; a URL não é endpoint (não há resolução de subject).

`id` do subject continua vindo de `deriveCredentialSubjectId` (ADR-0019 §5):
determinístico, com escopo por tenant, unidirecional. Nunca `doc_hmac`,
`doc_enc`, `subject_id` interno ou `validation.id`.

`claim.target_type` passou a ser lido da coluna real (`claim.target_type`,
enum `claim_target_type`) em vez de constante no loader. `building_key` é
transportado **verbatim** (sem re-derivação) porque é o binding canônico do
endereço que a assertion afirma. `address_id` é o identificador persistido do
endereço no grafo. Nenhum conceito de domínio novo é criado.

**`unit_key`:** não entra na VC porque **não faz parte do alvo do claim**.
`claim.address_id` referencia `canonical_address`, que é building-level e não
possui `unit_key` (as colunas `unit_key` existem nas tabelas de referência da
Receita, ligadas ao estabelecimento). Nada é inventado para "completar" o JSON,
e `building_key`/`unit_key` não são alterados em lugar nenhum.

Campos `null` no modelo interno são **omitidos** no documento (não viram `null`
JSON-LD). A forma continua determinística: presença/ausência é função da
assertion.

### 6. Evidence

A evidência usa a propriedade W3C `evidence` (§5.6), um item por
`claim_evidence`:

```json
"evidence": [
  {
    "id": "urn:uuid:<claim_evidence.id>",
    "type": ["comprova:Evidence"],
    "comprova:checker": "registry_match",
    "comprova:checkerVersion": "1",
    "comprova:stance": "supports",
    "comprova:strength": 0.9,
    "comprova:confidence": 0.8,
    "comprova:source": "receita",
    "comprova:observedAt": "2026-01-02T03:04:05.000Z",
    "comprova:evidenceSha256": "<64 hex>",
    "comprova:detail": { "…": "…" }
  }
]
```

- `id` e `type` são exigidos pela §5.6; o restante é namespace Comprova. O `id`
  é a URL `urn:uuid:<claim_evidence.id>` (§4.4); `comprova:supportingEvidence` e
  `comprova:contradictingEvidence` usam a mesma forma, para que possam ser
  confrontados diretamente com `evidence[].id`.
- **Nunca** entram `evidence_id` (FK efêmera) nem `s3_uri` (material físico).
- O binding durável é `comprova:evidenceSha256` (`claim_evidence.evidence_sha256`)
  mais `comprova:evidenceSetHash` (= `validation.evidence_set_hash`).
- O verifier **recomputa** o set hash a partir das próprias evidências da
  credencial, com o mesmo `evidenceSetHash` do `@comprova/core` (ADR-0017).
  Portanto a credencial continua verificável depois de `evidence_id → NULL` e da
  remoção do objeto no storage. Nenhuma tabela nova de evidências.
- `comprova:detail` é JSON opaco (estrutura variável). Sua integridade vem do
  set hash e da assinatura; nenhuma semântica RDF é atribuída a ele.
- A contagem `supporting/contradicting/unknown` **não** é duplicada no documento:
  é derivável das evidências já presentes. Ela permanece apenas na assertion
  interna.

### 7. Resultado, policy e algoritmo

```json
"comprova:result": {
  "comprova:verdict": "CONFIRMED_COMMERCIAL",
  "comprova:score": 0.9,
  "comprova:confidence": 0.8,
  "comprova:completedAt": "…",
  "comprova:explanation": {
    "comprova:code": "ADDRESS_CONFIRMED",
    "comprova:summary": "…",
    "comprova:supportingEvidence": ["urn:uuid:<claim_evidence.id>"],
    "comprova:contradictingEvidence": []
  }
},
"comprova:policy": { "comprova:version": "2026.13.1", "comprova:hash": "<64 hex>" },
"comprova:algorithm": { "comprova:scorerVersion": "1" }
```

Tudo dentro do conteúdo assinado. Não há registry/tabela de policy nem event
sourcing: o YAML continua sendo a fonte da policy, e a credencial a amarra por
hash + versão. O scoring não foi alterado.

`verdict`, `score`, `confidence` e `explanation` **não** recebem semântica W3C
inventada; são termos Comprova. Nenhuma tentativa de mapeá-los para
`evidence`/`confidenceMethod`/etc.

### 8. Tempo

A VC 2.0 usa `validFrom`/`validUntil` (não existe mais `issuanceDate`):

| Domínio                   | Documento W3C                                      |
| ------------------------- | -------------------------------------------------- |
| `validation.created_at`   | `validFrom`                                        |
| `validation.expires_at`   | `validUntil`                                       |
| `validation.completed_at` | `comprova:result.comprova:completedAt` (se ≠ NULL) |

> **Atualizado pelo [ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md)
> §5:** `validFrom` passou a ser `completed_at ?? created_at` — o início da
> validade é o momento em que o **veredito** passou a existir (a conclusão da
> validation), e não o início da validação. No fluxo rápido, em que
> `completed_at` é NULL, o fallback persistido é `created_at`.

`completed_at` pode ser `NULL` (fast path) e **não** é preenchido nem usado como
fallback de `validFrom`: quando ausente, a propriedade simplesmente não existe.

> **Atualizado pelo ADR-0024 §5:** ver a nota acima — quando `completed_at` é
> NULL, ele **é** usado como fallback de `validFrom` (por ser o limite inferior
> persistido da conclusão). `completed_at` continua não sendo preenchido.
> Nenhum timestamp é fabricado. A elegibilidade continua sendo só
> `status = 'completed'`; o domínio não foi alterado para preencher
> `completed_at`. A tensão entre retenção (30d) e material (180–365d) continua
> decisão de produto, fora do escopo.

### 9. Verifier independente

`verifyCredential(credential, { publicKey, expectedIssuerId?, expectedVerificationMethod? })`
recebe apenas o JSON da credencial e a chave pública. Não acessa
PostgreSQL/Redis/Temporal/S3/API.

> **Atualizado pelo [ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md)
> §6:** a API passou a ser
> `verifyCredential(credential, { trusted: { id, publicKey }, expectedIssuerId? })`.
> O `id` do método confiável é **obrigatório** e precisa ser exatamente o
> `proof.verificationMethod`: uma chave sem identidade não é suficiente para
> declarar confiança em um método.

Ordem das checagens:

1. forma (VC 2.0 + extensões Comprova);
2. `@context[0]` é o contexto base e `type` contém `VerifiableCredential`;
3. expectativa de `issuer` (quando fornecida) e **binding do
   `proof.verificationMethod` ao issuer declarado** (§5.9): o método precisa ser
   `<issuer>#<keyId>` (fragmento não vazio) e, se `expectedVerificationMethod`
   for passado, coincidir exatamente. Sem isto, um documento legítimo de A
   poderia se declarar emitido por B;
4. janela de validade bem formada (`validFrom ≤ validUntil`);
5. `comprova:evidenceSetHash` reconferido a partir da própria credencial;
6. proof Data Integrity `eddsa-jcs-2022` sobre o documento **cru** recebido
   (menos `proof`) — nunca sobre a versão normalizada pelo schema, para que a
   normalização não possa encobrir/alterar um campo —, exigindo
   `proofPurpose = assertionMethod` (uma prova emitida para outro motivo não vale
   como credencial).

No primitivo, o `proofConfig` é derivado do proof **cru** (menos `proofValue`),
não de uma cópia filtrada pelo schema: a Data Integrity permite propriedades
assinadas adicionais no proof (`expires`, `domain`, `challenge`, `nonce`,
`previousProof`, …) e elas precisam continuar cobertas pela assinatura e
verificáveis por terceiros.

Falhas classificadas: `MALFORMED_CREDENTIAL`, `UNSUPPORTED_CREDENTIAL`,
`UNSUPPORTED_CRYPTOSUITE`, `ISSUER_MISMATCH`,
`VERIFICATION_METHOD_MISMATCH`, `PROOF_PURPOSE_MISMATCH`, `INVALID_TIMESTAMP`,
`EVIDENCE_SET_MISMATCH`, `INVALID_SIGNATURE`.

Verificação ≠ validação: expiração no passado é política do consumidor, não do
`verifyCredential`.

### 10. Evidência de interoperabilidade

O teste `packages/credential/src/data-integrity.test.ts` reproduz o **vetor
normativo B.3** de VC DI EdDSA:

- canonicalização do documento e do proof config (exemplos 31 e 34);
- `sha256` de ambos (exemplos 32 e 35);
- concatenação (`proofHash || documentHash`, exemplo 36);
- assinatura Ed25519 (exemplo 37);
- `proofValue` multibase base58btc (exemplo 38).

Também são cobertos: vetores do RFC 8785 (números, escaping, ordenação por code
units UTF-16, rejeição de `NaN`/`Infinity`), base58btc/Multibase, o mapping
completo, adulteração de cada campo assinado e classificação de falhas. Em
`credential.test.ts` há ainda: determinismo por ordem de observações e por ordem
de propriedades JSON, autocontenção (transporte JSON + verificação só com a chave
pública), invariância ao ponteiro material (`evidence_id`), binding do
`verificationMethod` ao issuer, `proofPurpose` obrigatório, casos negativos (sem
`@context`/`type`/`issuer`/`credentialSubject`/`proof`, cryptosuite inesperada) e
a retenção de material (cenário de integração na API). Em `data-integrity.test.ts`
há uma prova assinada com propriedades adicionais (`expires`, `domain`,
`challenge`, `nonce`) para garantir que a verificação não as descarta.

### 11. Compatibilidade com o contrato anterior

- `AssertionPayload` **não foi renomeado** nem achatado em campos W3C; continua
  sendo a assertion interna, com `format: 'comprova-assertion-v1'` e a mesma
  forma canônica. A mudança desta etapa foi o payload passar a carregar
  `claim.target.type` a partir da coluna real (o valor já era `'address'`), sem
  alterar a forma.
- O documento W3C tem tipos próprios (`VerifiableCredential`,
  `SecuredVerifiableCredential`), separados da assertion interna — não há
  alteração silenciosa de contrato.
- Foram removidos apenas `Credential = { payload, proof }`,
  `CredentialProof`/`CredentialSchema` e `canonicalAssertion*`, que
  materializavam o envelope experimental substituído. Antes da remoção,
  verificou-se que não havia consumidores fora do próprio pacote e dos testes
  (a API só usava o tipo `Credential`, agora `SecuredVerifiableCredential`).
- Na revisão de conformidade desta PR, os `id` do documento passaram de UUID nu
  para `urn:uuid:<uuid>` (Data Model §4.4) e o verifier passou a exigir
  `proofPurpose = assertionMethod` e o binding `verificationMethod ↔ issuer`.
  Nada disso altera `AssertionPayload` (o domínio continua com UUIDs) nem o
  `evidence_set_hash`; são mudanças de forma do documento W3C e de política de
  verificação, feitas antes de existir qualquer consumidor do documento.

## Itens deliberadamente NÃO implementados

DID / DID Document / resolução / rotação de chave; `id` da credencial;
revogação / status list; TSA/RFC 3161; wallet; selective disclosure
(SD-JWT/BBS+); KMS/HSM; registry de issuer/verifier; banco de credenciais;
endpoint HTTP de emissão; event sourcing, hash-chain, Merkle, blockchain.
Nenhuma tabela nova. Nenhuma mudança em `building_key`, `unit_key`, scoring,
checkers, thresholds, hard rules, policy YAML, T0/T1/T2, retenção, semântica de
`validation` ou `subject.doc_hmac`.

**`id` da credencial:** omitido. É opcional na VC 2.0; o único candidato natural
(`validation.id`) é identificador interno, e identidade/linkabilidade de
credencial é decisão de produto em aberto (revogação). A omissão é deliberada,
não esquecimento.

## Decisões não fixadas pelo briefing

O briefing exige a cryptosuite EdDSA "apropriada para Ed25519" e a
canonicalização "exigida pela Data Integrity", mas não fixa os pontos abaixo.
Eles foram decididos aqui, com justificativa acima, e a troca é localizada:

1. cryptosuite `eddsa-jcs-2022` em vez de `eddsa-rdfc-2022` (§2);
2. `proof.created` derivado da assertion (determinismo) em vez de `now()` na
   emissão (§2);
3. `created_at → validFrom` e `completed_at → comprova:completedAt` (em vez de
   `validFrom = completed_at`) (§8);
4. `id` da credencial omitido (§ abaixo);
5. contagem de stances não duplicada no documento (§6);
6. identificadores internos (UUID) expressos como URL `urn:uuid:` (§5).

> **Atualizado pelo [ADR-0024](0024-conformidade-w3c-identificadores-e-tempos.md):**
> os itens 2 e 3 foram revistos (§4 e §5 do ADR-0024): `proof.created` voltou a
> ser o instante real da emissão (com relógio injetável) e `validFrom` passou a
> ser `completed_at ?? created_at`. Os demais itens seguem como decididos aqui.

## Consequências

- A saída é interoperável: terceiros verificam com apenas o JSON e a chave
  pública, usando qualquer implementação conforme de `eddsa-jcs-2022`.
- O snapshot interno permanece; o documento W3C é mapping puro — não há duas
  fontes de verdade nem representação persistida da credencial.
- O ADR-0019 §1/§2/§3/§9 fica superseded; §4–§8 (issuer, subject derivado,
  evidence binding, policy/scorer, terminalidade) continua em vigor.
- Pendências (fora de escopo): `id`/linkabilidade da credencial, revogação,
  publicação/resolução de chave, porta HTTP de emissão e alinhamento entre a
  janela da assertion e a retenção do material.
