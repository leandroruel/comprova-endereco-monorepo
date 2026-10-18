# ADR-0024: Conformidade W3C de identificadores e tempos na credencial (issuer, subject, `proof.created`, `validFrom` e vínculo da chave)

## Status

Aceito (2026-10-18). **Substitui parcialmente o
[ADR-0020](0020-verifiable-credential-data-model-2.md)** (§2 `proof.created`,
§3 issuer/`verificationMethod`, §5 `credentialSubject.id`, §8 tempo e §9
verifier) e o [ADR-0019](0019-credential-emission-layer.md) §4 (issuer) e §5
(subject). O restante do ADR-0020 — três camadas, cryptosuite
`eddsa-jcs-2022`/JCS, mapping em `vc.ts`, `evidence`, policy/scorer, separação
da biblioteca — continua em vigor.

## Contexto

A camada de credencial (ADR-0020) já emitia VC Data Model 2.0 com Data Integrity
`eddsa-jcs-2022` e verificador independente. A auditoria de conformidade
encontrou cinco pendências, todas de **forma do documento ou de política de
verificação** — nenhuma de domínio:

1. `issuer = comprova:issuer:<tenant_id>` não é uma URL: a VC 2.0 exige que o
   `issuer` seja identificado por uma URL/IRI (§4.6), e o esquema inventado não é
   resolvível nem interoperável;
2. `credentialSubject.id = sha256:<digest>` é um **esquema de URI proprietário**,
   não uma representação padronizada;
3. `proof.created` era derivado de `validation.completed_at ?? createdAt` — um
   timestamp histórico da validação registrado como momento da assinatura;
4. `expectedVerificationMethod` era opcional no verificador: uma chave pública
   avulsa valia para qualquer `verificationMethod` declarado na credencial;
5. `validFrom = validation.created_at` (início da validação), não o momento a
   partir do qual a afirmação certificada passou a valer.

**Origem do projeto:** o domínio `comprova.dev` aparece no repositório apenas
como IRI de contexto (`packages/credential/src/vc.ts`) e de `problem+json`
(`packages/contracts/src/problem.ts`). Não há configuração, DNS, deploy ou
documentação que confirme controle desse domínio — então ele **não** foi
promovido a base dos identificadores. Decidir o domínio real é uma decisão de
infraestrutura, não desta camada.

Restrições mantidas: VC 2.0 + Data Integrity 1.0 + `eddsa-jcs-2022` + Ed25519 +
JCS/RFC 8785; `packages/credential` puro (sem banco/Redis/Temporal/S3); sem
migração; `building_key`, `unit_key`, `subject.doc_hmac` e `subject_id`
intocados; sem DID/DID Document, resolução de chave, revogação ou wallet.

## Decisão

### 1. Origem explícita e validada (nada de domínio inventado)

- `parseIssuerOrigin` (`packages/credential/src/issuer.ts`) valida e normaliza a
  origem: **HTTPS**, sem credenciais, path, query ou fragmento; devolve a forma
  canônica (`https://host[:port]`).
- A origem entra pela configuração da aplicação —
  `CREDENTIAL_ISSUER_ORIGIN` (`apps/api/src/config.ts`, obrigatória, validada pelo
  mesmo parser via `IssuerOriginSchema`) — e por dependência explícita na
  biblioteca. **A biblioteca não tem default e não lê env.**
- Enquanto não houver domínio confirmado, o valor de desenvolvimento é uma
  origem reservada (`https://issuer.test`), que nunca resolve: o identificador é
  honesto sobre não ter domínio de produção.
- Trocar a origem depois **muda** os identificadores emitidos. Não há tabela de
  credenciais nem histórico persistido, então não há dado a reescrever; credenciais
  já entregues continuariam verificáveis (o `issuer` viaja dentro do documento
  assinado), mas deixariam de ser resolvíveis na nova origem.

### 2. `issuer.id`: URL HTTPS com escopo opaco do tenant

```
issuer.id            = <origem>/issuers/<escopo>
escopo               = base64url(sha256("comprova:issuer:v1" | <tenant_id>))   # 43 chars
verificationMethod   = <issuer.id>#<keyId>
```

- **estável:** mesma origem + mesmo tenant → mesmo `id`, entre emissões;
- **isolado:** tenants diferentes nunca compartilham `id`;
- **não expõe identificador interno:** o `tenant_id` (UUID) não aparece na URL,
  apenas um digest unidirecional e com domínio de separação;
- **rotação de chave não muda a identidade:** a chave vive no fragmento, então
  trocar `key-1` por `key-2` muda o `verificationMethod` e mantém o `issuer`;
- `keyId` é validado como fragmento de URL (não vazio, sem espaço/`#`/`?`).

**Interoperabilidade futura (NÃO implementada):** para um consumidor externo
descobrir a chave, é preciso publicar o documento do issuer em `GET <issuer.id>`
com `verificationMethod[]` (chave pública, provavelmente `publicKeyMultibase`) e
um `controller`/`assertionMethod`. Hoje a chave pública é **injetada** no
verificador (ADR-0019 §3): um terceiro verifica com a chave que já conhece, sem
resolução. Migrar para `did:web:<host>:issuers:<escopo>` no futuro troca a
construção do `id`, não o resto do documento.

### 3. `credentialSubject.id`: URL no namespace do issuer

```
credentialSubject.id = <issuer.id>/subjects/<digest>
digest               = sha256("comprova:credential-subject:v1" | tenant_id | doc_type | doc_hmac_hex)   # hex
```

O **digest é exatamente o mesmo** de antes (ADR-0019 §5): só a representação
mudou, de `sha256:<digest>` para o path de uma URL HTTPS. Continua
determinístico, com escopo por tenant (o `tenant_id` está no digest **e** no
namespace da URL, defesa em profundidade se a forma da URL mudar),
unidirecional, sem expor CPF/CNPJ/`doc_hmac`, sem ler ou alterar
`subject.doc_hmac`/`subject_id`. A URL é um identificador pseudônimo, **não** um
endpoint: não existe (nem passa a existir) resolução pública de subject.

**Linkabilidade (deliberada):** o digest **não** inclui a origem, então o sufixo
do subject é o mesmo antes e depois de uma migração de domínio. É o preço de o
pseudônimo ser estável por (tenant, documento) — que é justamente o objetivo de
um identificador estável. Incluir a origem no digest daria um identificador novo
a cada domínio sem esconder nada: quem recebe duas credenciais do mesmo sujeito
correlaciona-as pelo próprio digest (ele é função do `doc_hmac`, por design).
Correlacionar subjects **entre tenants diferentes** continua impossível.

### 4. `proof.created`: o instante real da criação da prova

- `buildCredential(source, { issuer, signer, now? })`; `created = (now ?? (() =>
new Date()))().toISOString()`. Nenhum timestamp histórico da validation
  (`created_at`, `completed_at`) é reutilizado como momento de assinatura.
- **Determinismo em teste** por relógio injetável (`now`), não por adivinhar o
  tempo a partir da assertion.
- **Reemissão:** o documento sem `proof` continua determinístico (função da
  assertion), mas a **prova** não — cada emissão cria uma prova nova com
  `created` real. Reproduzir bytes exigiria persistir o instante da emissão
  original e injetá-lo explicitamente (`now`); a camada não faz isso sozinha, e
  não há tabela de credenciais emitidas. Ou seja: **reemitir ≠ reproduzir**; o
  procedimento para reproduzir é documentado, o produto é que decide se o quer.

### 5. `validFrom`: início da validade do veredito (o instante REAL da conclusão)

| Domínio                   | Documento W3C                            |
| ------------------------- | ---------------------------------------- |
| `validation.completed_at` | `validFrom` **e** `comprova:completedAt` |
| `validation.expires_at`   | `validUntil`                             |
| `validation.created_at`   | (nenhum: é o início da requisição)       |

- A informação certificada é o **veredito** da validation: ele passa a existir
  quando a análise é concluída. `validFrom = created_at` (decisão anterior)
  declarava válido o que ainda não existia durante a janela em que a validação
  estava pendente.
- **`created_at` não é a conclusão.** O fluxo rápido captura `now` no início de
  `runFastPath` (`apps/api/src/services/fastpath.ts`), antes das consultas à
  Receita, do enriquecimento do endereço e dos checkers — a conclusão pode vir
  segundos depois. Por isso o fluxo rápido passou a **persistir
  `completed_at`** no fim da análise quando o resultado é terminal completo,
  com a mesma semântica do deep path (`updateValidationOutcome`): `partial` e
  `queued` continuam NULL (o worker preenche quando concluir). **Sem migração:**
  a coluna já existia e era preenchida só pelo deep path.
- **Registros sem `completed_at` (dados anteriores):** a emissão é
  **recusada** — `COMPLETION_TIME_MISSING` na fronteira
  (`apps/api/src/services/credential-issuer.ts`) e
  `validation has no completion timestamp (completed_at)` em `buildAssertion`.
  Não se presume `created_at`: com a conclusão desconhecida não há `validFrom`
  honesto a declarar, e declarar mais cedo do que se sabe é afirmar o que não se
  sabe. Como as duas rotas que produzem `status = 'completed'` passam a gravar o
  campo, a recusa atinge apenas registros criados antes desta correção.
- `proof.created` **não** entra em `validFrom`: emitir não define desde quando a
  informação vale.
- A janela de validade continua `[completed_at, expires_at]`, e `expires_at`
  segue como o início da requisição mais 30 dias (retenção): a análise consome
  parte da janela. Mudar essa base é decisão de produto, fora do escopo.

### 6. Verificador: a chave confiável carrega a identidade do método (obrigatória)

```ts
verifyCredential(credential, {
  trusted: { id: '<issuer>#<keyId>', publicKey },  // obrigatório
  expectedIssuerId?,                               // expectativa do consumidor
})
```

Ordem das checagens: forma do documento → contexto/tipo → `expectedIssuerId`
(se informado) → **`verificationMethod` pertence ao `issuer` declarado**
(`<issuer>#<fragmento não vazio>`) → **`verificationMethod === trusted.id`** →
janela de validade → `evidenceSetHash` recomputado → assinatura Data Integrity
sobre o documento cru, com a chave de `trusted`, exigindo
`proofPurpose = assertionMethod`.

- **Por quê:** um `KeyObject` não tem identidade. Com `expectedVerificationMethod`
  opcional, uma assinatura válida com a chave fornecida era aceita para
  **qualquer** método declarado: `#key-1` e `#key-2` do mesmo issuer assinam com
  a mesma chave, e a credencial escolhia em qual deles o consumidor estaria
  confiando. A identidade do método agora é parte do que se declara confiar.
- Com a checagem estrutural **mais** a exigência de igualdade, aceitar implica
  `issuer` declarado = issuer do método confiável, sem precisar de resolução.
- **Responsabilidades explícitas e separadas:** (a) integridade criptográfica +
  vínculo com a identidade declarada → `verifyCredential`; (b) confiança na chave
  do issuer → o consumidor, ao escolher `trusted`; (c) validade temporal da
  credencial → política de quem consome (o verificador só valida a coerência da
  janela); (d) revogação/status → **não implementado** (fora de escopo).
- Sem trust registry, sem DID: `trusted` é a chave que o consumidor já confia.

## Compatibilidade e impacto

- **Mudanças de forma do documento:** `issuer`, `credentialSubject.id` e
  `proof.created` (valores), `validFrom` (semântica).
- **Mudanças de API:** `verifier.ts` (`trusted` obrigatório em vez de
  `publicKey`/`expectedVerificationMethod`), `issuer.ts`
  (`localIssuer(origem, tenant, keyId)`, `parseIssuerOrigin`,
  `issuerScopeOf`), `subject.ts` (`deriveCredentialSubjectId` recebe `issuerId`),
  `credential.ts` (`now` no lugar de `proofCreatedAt`; `buildAssertion` recusa
  `completed_at` ausente e `AssertionPayload['timestamps']['completed_at']` deixa
  de ser nullable) e `apps/api/src/services/credential-issuer.ts`
  (`IssueCredentialDeps` recebe `issuerOrigin`/`keyId`/`now`; a falha
  `ISSUER_MISMATCH` deixa de existir e surge `COMPLETION_TIME_MISSING`).
- **Mudança de domínio (campo que já existia):** o fluxo rápido passa a gravar
  `validation.completed_at` (instante da conclusão). É o único ponto de escrita
  novo: nada de coluna, índice, tabela ou regra de elegibilidade nova.
- **`comprova:completedAt` na leitura:** segue `optional` no schema da
  credencial. O emissor sempre o escreve (é o mesmo instante de `validFrom`),
  mas ele é proveniência descritiva; a verificação temporal usa `validFrom`,
  que é obrigatório.
- **Atribuição de issuer:** o serviço **deriva** o issuer da origem configurada +
  tenant escopado pela leitura (RLS), então não existe mais caminho para um
  caller atribuir a assertion de um tenant ao issuer de outro — a garantia virou
  estrutural, não uma checagem que podia ser contornada.
- **Nenhuma migração:** nada de schema novo; `validFrom` usa `completed_at`, que
  já existia (preenchido pelo deep path, agora também pelo fluxo rápido).
- **Configuração:** `CREDENTIAL_ISSUER_ORIGIN` é obrigatória para a API subir
  (documentada no `.env.example` e no README).
- Não havia consumidor externo do documento nem emissão por HTTP quando estas
  mudanças entraram (ADR-0020: "endpoint HTTP de emissão" não implementado).

## Testes

- `issuer.test.ts` (novo): validação/normalização da origem, URL do issuer,
  estabilidade na rotação de chave, isolamento entre tenants/origens, `keyId`
  inválido.
- `subject.test.ts`: URL no namespace do issuer, determinismo, isolamento por
  tenant e por origem, ausência de `doc_hmac`/`tenant_id`, digest inalterado.
- `vc.test.ts`: `validFrom` = `completed_at` (nunca `created_at`); subject como
  URL.
- `credential.test.ts`: `proof.created` = relógio injetado, distinto de
  `created_at`/`completed_at`; reemissão gera nova prova sobre o mesmo documento;
  recusa de emissão sem `completed_at`; caso negativo do método confiável (mesma
  chave assinando `#key-1` e `#key-2`); chave errada, issuer esperado
  incompatível, `proofPurpose` incorreto, adulteração de todos os campos
  assinados.
- `apps/api/src/credential.int.test.ts`: fluxo ponta a ponta (validation →
  credencial → verificação), `validFrom` do fluxo rápido, **fluxo rápido com
  relógio que avança entre início e conclusão da requisição** (o `completed_at`
  persistido é a conclusão, e `validFrom` não a antecede), registro concluído sem
  `completed_at` → `COMPLETION_TIME_MISSING`, issuer derivado do tenant,
  `proof.created` real e adulterável, retenção do material físico.
- O vetor normativo B.3 (`data-integrity.test.ts`) e o RFC 8785 continuam
  passando — a canonicalização e o cryptosuite não foram tocados.

## Itens deliberadamente NÃO implementados (limitações restantes para consumidores externos)

- **Resolução de chave:** não há documento do issuer publicado em
  `GET <issuer.id>`. Um verificador externo precisa receber a chave pública
  (e o id do método) por outro canal. Sem isso, o `verificationMethod` é
  verificável, mas não descobrível.
- **DID / `did:web`:** não implementado; a forma do `id` é compatível com uma
  migração futura.
- **Revogação / status list:** não implementado. A credencial não carrega
  `credentialStatus`; expiração é do consumidor.
- **`id` da credencial:** segue omitido (linkabilidade é decisão de produto).
- **Domínio de produção:** a origem (e o IRI de contexto
  `https://comprova.dev/ns/credentials/v2#`) ficam pendentes de um domínio
  confirmado. O contexto é inline e a verificação é JCS (não JSON-LD), então não
  precisa resolver; alinhar contexto e origem deve ser uma decisão única quando o
  domínio existir.
- **Envelope temporal:** `validUntil` continua sendo `expires_at`
  (= `created_at` + 30d) e a tensão entre retenção (30d) e material
  (180–365d) continua decisão de produto.
