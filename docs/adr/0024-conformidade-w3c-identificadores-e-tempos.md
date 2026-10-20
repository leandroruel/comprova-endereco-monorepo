# ADR-0024: Conformidade W3C de identificadores e tempos na credencial (issuer, subject, `proof.created`, `validFrom` e vínculo da chave)

## Status

Aceito (2026-10-18). **Revisado em 2026-10-20** após o PR #5 (ver “Revisão
pós-PR #5” ao final). **Substitui parcialmente o
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

> **Atualizado pelo [ADR-0028](0028-did-e-did-document-do-issuer.md):** o
> `did:web:<host>:issuers:<escopo>` foi implementado como uma camada de
> resolução **adicional**. O `issuer.id` da credencial continua sendo a URL
> HTTPS; o DID é derivado deterministicamente dela e o DID Document declara a
> URL em `alsoKnownAs`. Nenhuma credencial já emitida deixou de ser verificável.

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
  original e injetá-lo explicitamente (`now`); a camada não faz isso sozinha.
  **Atualizado na Revisão pós-PR #5 (B2):** a fronteira HTTP passou a persistir a
  primeira emissão (`credential_issuance.issued_at`) e a reemitir com
  `proof.created = issued_at`, de modo que **reemitir = reproduzir** enquanto
  issuer/chave/policy não mudarem. Ver a seção ao final deste ADR.

### 5. `validFrom`: início da validade do veredito (o instante REAL da conclusão)

| Domínio                                                                      | Documento W3C                            |
| ---------------------------------------------------------------------------- | ---------------------------------------- |
| `validation.completed_at`                                                    | `validFrom` **e** `comprova:completedAt` |
| `completed_at + policy.credential_ttl_seconds` ↔ `observed_at + ttl_seconds` | `validUntil` (o menor)                   |
| `validation.expires_at`                                                      | `comprova:expiresAt` (retenção)          |
| `validation.created_at`                                                      | (nenhum: é o início da requisição)       |

> A linha de `expires_at` acima reflete a Revisão pós-PR #5 (B1): `expires_at`
> **não** é mais `validUntil`; ele continua sendo o horizonte de retenção.

- A informação certificada é o **veredito** da validation: ele passa a existir
  quando a análise é concluída. `validFrom = created_at` (decisão anterior)
  declarava válido o que ainda não existia durante a janela em que a validação
  estava pendente.
- **`created_at` não é a conclusão.** O fluxo rápido captura `now` no início de
  `runFastPath` (`apps/api/src/services/fastpath.ts`), antes das consultas à
  Receita, do enriquecimento do endereço e dos checkers — a conclusão pode vir
  segundos depois. Por isso o fluxo rápido passou a **persistir
  `completed_at`** no fim da análise quando o resultado é terminal completo:
  `partial` e `queued` continuam NULL (o worker preenche quando concluir). **Sem
  migração:** a coluna já existia e era preenchida só pelo deep path.
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
- **O instante de conclusão não é o instante de avaliação.** A leitura do relógio
  que abre o processamento serve aos cálculos (freshness, score, decisão e TTL do
  cache de sinais); a conclusão é lida **depois** dos verificadores e do resultado
  final, o mais perto possível da persistência:
  - **Fluxo rápido:** as duas leituras já eram separadas (`now` no início de
    `runFastPath`; `completed_at` ao fim da análise).
  - **Deep path:** `deepEnrich` passou a separar as duas. O `now` inicial virou
    `evaluatedAt` (avaliação: `weightedScore`, `decide`, `evaluateClaim` e o TTL
    do `address_signal_cache`) e `completedAt = deps.clock.now()` é lido dentro da
    transação, imediatamente antes de `updateValidationOutcome`. O campo do write
    foi renomeado de `now` para `completedAt`, para que o nome diga o que o valor
    é. Uma execução de minutos registrava o **início** do processamento como
    conclusão.
  - Regra preservada em ambos: resultado terminal **completo** grava a conclusão;
    `partial`/`queued` mantêm `completed_at = NULL`.
  - **`completed_at` é o instante da PRIMEIRA conclusão terminal, não o da última
    execução do worker** (idempotência temporal). Um retry/replay que **reproduz**
    o resultado terminal persistido — mesmo veredito sobre o mesmo conjunto de
    evidências (`evidence_set_hash`) — **preserva** o `completed_at` original:
    reexecutar o worker não é reconcluir, e avançar o instante mudaria o
    `validFrom` de credenciais emitidas depois sem nenhuma conclusão nova. Uma
    execução que produz um resultado terminal **novo** (veredito, evidências,
    policy ou scorer diferentes) é uma conclusão nova e grava o instante real —
    preservar o instante antigo anteciparia a existência de conteúdo que só
    passou a existir ali. A comparação usa veredito + hash de evidências +
    `policy_hash` + `scorer_version` (valores exatos); `score`/`confidence`
    ficam de fora porque são colunas `real` (float4) — a comparação de float não
    é confiável, e são funções determinísticas do conjunto de evidências e da
    policy. **Atualizado na Revisão pós-PR #5 (A3):** a versão original desta
    seção comparava só veredito + evidências e deixava a mudança de policy sem
    detecção. O `policy_hash`/`scorer_version` da LINHA continuam imutáveis
    (migração 0028); o deep path detecta a divergência contra a policy do worker
    e grava novo `completed_at`, mas não reescreve o binding original. As
    consequências e a decisão pendente estão na Revisão pós-PR #5 (A3/C1).
    Casos de borda: um registro legado concluído **sem** `completed_at` que seja
    reprocessado grava o instante da reexecução (não há original a preservar, e
    é o único valor honesto disponível); um replay que regresse a `partial`
    zera `completed_at` (comportamento existente de `updateValidationOutcome` —
    a conclusão foi retraída junto com o status e a emissão falha fechada) e
    revoga a credencial superada (C1).
- **Garantia de janela não vazia (`validFrom < validUntil`).** `validUntil` é
  calculado por `min(completed_at + policy.credential_ttl_seconds,
observed_at + ttl_seconds)` (B1) e pode ser menor que `completed_at` quando
  uma evidência já expirou. A emissão **recusa** `validUntil <= completed_at` na
  fronteira (`VALIDITY_WINDOW_INVALID`) e `buildAssertion` impõe a mesma
  invariante. **`expires_at` não é recalculado nem estendido na emissão:** ele
  continua sendo o horizonte persistido de retenção (o job apaga a validation em
  `expires_at`), e esticá-lo aqui mudaria em silêncio a política de retenção.
  Recusar é a resposta honesta: quando o resultado concluiu fora do horizonte da
  própria credencial, a informação certificada já expirou.
- A janela de validade da credencial é `[completed_at, validUntil)`, com
  `validUntil` distinto de `expires_at` (retenção). O detalhe do cálculo, do
  default e dos testes está na Revisão pós-PR #5 (B1).

### 6. Verificador: a chave confiável carrega a identidade do método (obrigatória)

```ts
verifyCredentialIntegrity(credential, {
  trusted: { id: '<issuer>#<keyId>', publicKey },  // obrigatório
  expectedIssuerId?,                               // expectativa do consumidor
})
```

Ordem das checagens: forma do documento → contexto/tipo → `expectedIssuerId`
(se informado) → **`verificationMethod` pertence ao `issuer` declarado**
(`<issuer>#<fragmento não vazio>`) → **`verificationMethod === trusted.id`** →
janela de validade (**não invertida: `validFrom <= validUntil`**, VC 2.0 §4.9) e,
se `now` for informado, `validFrom <= now < validUntil` → `evidenceSetHash`
recomputado → assinatura Data Integrity sobre o documento cru, com a chave de
`trusted`, exigindo `proofPurpose = assertionMethod`.

- **Por quê:** um `KeyObject` não tem identidade. Com `expectedVerificationMethod`
  opcional, uma assinatura válida com a chave fornecida era aceita para
  **qualquer** método declarado: `#key-1` e `#key-2` do mesmo issuer assinam com
  a mesma chave, e a credencial escolhia em qual deles o consumidor estaria
  confiando. A identidade do método agora é parte do que se declara confiar.
- Com a checagem estrutural **mais** a exigência de igualdade, aceitar implica
  `issuer` declarado = issuer do método confiável, sem precisar de resolução.
- **Responsabilidades explícitas e separadas:** (a) integridade criptográfica +
  vínculo com a identidade declarada → `verifyCredentialIntegrity`; (b) confiança
  na chave do issuer → o consumidor, ao escolher `trusted`; (c) validade
  temporal → `checked.time` quando `now` é informado, sem esconder que sem
  `now` o tempo não foi checado; (d) revogação/status → **não** é checada por
  `verifyCredentialIntegrity` (`checked.status = 'not_checked'`); quem consome
  usa um `statusResolver` (ADR-0027).
- Sem trust registry, sem DID: `trusted` é a chave que o consumidor já confia.
  O DID Document (ADR-0028) é uma forma adicional de descobrir a chave; ele não
  substitui o `issuer` HTTPS nem o `trusted` do verificador.

## Compatibilidade e impacto

- **Mudanças de forma do documento:** `issuer`, `credentialSubject.id` e
  `proof.created` (valores), `validFrom` (semântica).
- **Mudanças de API:** `verification.ts` (`trusted` obrigatório em vez de
  `publicKey`/`expectedVerificationMethod`; `verifyCredential` renomeado para
  `verifyCredentialIntegrity` e passou a devolver `checked` e a aceitar `now`;
  janela `validFrom <= validUntil`, e `[validFrom, validUntil)` quando `now` é
  informado), `issuer.ts` (`localIssuer(origem, tenant, keyId)`,
  `parseIssuerOrigin`, `issuerScopeOf`), `subject.ts`
  (`deriveCredentialSubjectId` recebe `issuerId`), `credential.ts` (`now` no
  lugar de `proofCreatedAt`; `buildAssertion` recusa `completed_at` ausente
  **e** janela vazia/invertida (`completed_at >= validUntil`) e
  `AssertionPayload['timestamps']['completed_at']` deixa de ser nullable) e
  `apps/api/src/services/credential-issuer.ts` (`IssueCredentialDeps` recebe
  `issuerOrigin`/`keyId`/`now` e `credentialTtlSeconds`; a falha
  `ISSUER_MISMATCH` deixa de existir e surgem `COMPLETION_TIME_MISSING` e
  `VALIDITY_WINDOW_INVALID`).
- **Mudança interna do worker (sem API pública):**
  `ValidationOutcomeWrite.now` virou `ValidationOutcomeWrite.completedAt` em
  `deep-enrich.persistence.ts` — o valor é o instante a registrar como conclusão
  (novo ou preservado do replay), não o de avaliação, e o nome agora diz isso.
  `deepEnrich` lê o relógio na abertura (avaliação) e só lê de novo quando há
  conclusão nova a registrar. Nada muda no schema, na persistência de `partial`
  ou na arquitetura do Temporal.
- **Mudança de domínio (idempotência temporal):** reexecutar o deep path de uma
  validação já `completed` deixou de avançar `completed_at` quando o resultado é
  reproduzido (mesmo veredito + mesmo `evidence_set_hash`). Como `validFrom` é
  `completed_at`, credenciais emitidas depois de um replay continuam ancoradas na
  conclusão original.
- **Mudança de domínio (campo que já existia):** o fluxo rápido passa a gravar
  `validation.completed_at` (instante da conclusão) e a fronteira de emissão
  passa a recusar janela vazia/invertida. Nada de coluna, índice, tabela ou
  migração: são duas invariantes sobre campos que já existiam.
- **Uma dependência de workspace a mais (só em teste):** `apps/worker` declara
  `@comprova/credential` em `devDependencies`, para o teste de integração provar
  que a credencial derivada do deep path usa o instante de conclusão. Nenhuma
  dependência externa nova.
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
  recusa de emissão sem `completed_at`; recusa de janela vazia/invertida
  (`completed_at == expires_at` e `completed_at > expires_at`; 1 ms antes ainda
  emite, com `validFrom < validUntil`); caso negativo do método confiável (mesma
  chave assinando `#key-1` e `#key-2`); chave errada, issuer esperado
  incompatível, `proofPurpose` incorreto, janela de validade vazia/invertida no
  verificador, adulteração de todos os campos assinados.
- `apps/api/src/credential.int.test.ts`: fluxo ponta a ponta (validation →
  credencial → verificação), `validFrom` do fluxo rápido, **fluxo rápido com
  relógio que avança entre início e conclusão da requisição** (o `completed_at`
  persistido é a conclusão, e `validFrom` não a antecede), registro concluído sem
  `completed_at` → `COMPLETION_TIME_MISSING`, **janela de validade na fronteira**
  (conclusão 1 ms antes do horizonte emite e verifica; conclusão igual ou
  posterior ao horizonte → `VALIDITY_WINDOW_INVALID`, com `expires_at` intacto),
  issuer derivado do tenant, `proof.created` real e adulterável, retenção do
  material físico.
- `apps/worker/src/modules/deep-enrich/deep-enrich.int.test.ts`: **relógio
  controlado no deep path** — a validação nasce em `queued` com `created_at = T0`
  (sem `completed_at`), `deepEnrich` roda com um relógio que avança e o registro
  conclui com `completed_at = T1 > T0`; a credencial emitida daí tem
  `validFrom = completed_at` (nunca `created_at`) e verifica. O mesmo arquivo
  cobre: **replay do mesmo resultado terminal preserva o `completed_at` original**
  (nunca avança para T2 nem volta a NULL, e a credencial emitida depois do replay
  continua com `validFrom = T1`); **reexecução com evidências novas é conclusão
  nova** (mesmo veredito, `evidence_set_hash` diferente → novo instante — prova de
  que a preservação não é incondicional); e o caminho parcial (`completed_at`
  permanece NULL, inclusive em replay).
- O vetor normativo B.3 (`data-integrity.test.ts`) e o RFC 8785 continuam
  passando — a canonicalização e o cryptosuite não foram tocados.

## Itens deliberadamente NÃO implementados (limitações restantes para consumidores externos)

- **Resolução de chave:** não há documento do issuer publicado em
  `GET <issuer.id>`. Um verificador externo precisa receber a chave pública
  (e o id do método) por outro canal. Sem isso, o `verificationMethod` é
  verificável, mas não descobrível. (Implementado no
  [ADR-0025](0025-emissao-http-e-chave-publica-do-issuer.md); o DID Document do
  [ADR-0028](0028-did-e-did-document-do-issuer.md) é uma segunda porta de
  resolução.)
- **DID / `did:web`:** implementado no
  [ADR-0028](0028-did-e-did-document-do-issuer.md) como camada adicional de
  resolução, sem trocar o `issuer.id` da credencial.
- **Revogação / status list:** não implementado. A credencial não carrega
  `credentialStatus`; expiração é do consumidor.
- **`id` da credencial:** segue omitido (linkabilidade é decisão de produto).
- **Domínio de produção:** a origem (e o IRI de contexto
  `https://comprova.dev/ns/credentials/v2#`) ficam pendentes de um domínio
  confirmado. O contexto é inline e a verificação é JCS (não JSON-LD), então não
  precisa resolver; alinhar contexto e origem deve ser uma decisão única quando o
  domínio existir.
- **Envelope temporal:** **atualizado na Revisão pós-PR #5 (B1).** `validUntil`
  deixou de ser `expires_at`; agora é
  `min(completed_at + policy.credential_ttl_seconds, observed_at + ttl_seconds)`.
  `expires_at` continua sendo o horizonte de retenção (`created_at` + 30d). A
  tensão entre retenção e TTL das evidências segue decisão de produto; a emissão
  não estica nenhum dos dois horizontes e recusa `VALIDITY_WINDOW_INVALID`
  quando a janela resultante é vazia/invertida.

## Revisão pós-PR #5 (2026-10-20)

Revisão de conformidade W3C VC 2.0 sobre o estado do PR #5. As correções foram
feitas em commits pequenos, um por item, com testes: `82af9d4` (A1), `b919ade`
(A2), `27c5aa3` (A3), `4bb729a` (A4), `e8e7740` (B1), `24d1cd9` (B2), `1146c68`
(C1) e `f1d043b` (C2). Quando esta seção divergir de um trecho anterior, **esta
seção prevalece**.

### A1 — origem do issuer em produção

`assertProductionIssuerOrigin` (`packages/credential/src/service/issuer.service.ts`)
passou a ser aplicada no boot da API. Em `NODE_ENV=production`, a origem
`CREDENTIAL_ISSUER_ORIGIN` é recusada quando:

- usa TLD reservado (`.test`, `.example`, `.invalid`, `.localhost`, `.local`);
- é `localhost` (ou um subdomínio `*.localhost`);
- é um IP literal (IPv4 ou IPv6).

Fora de produção o comportamento não mudou: a suíte usa
`https://issuer.test` e continua aceita. A validação anterior (HTTPS, sem
credenciais/path/query/fragmento, host canônico) permanece. Testes cobrem os
dois ambientes em `apps/api/src/config.test.ts`; `.env.example` documenta a
restrição.

**Motivo:** uma credencial é uma afirmação pública. Aceitar uma origem que
nunca será controlada pelo projeto em produção produziria identificadores
irresolúveis e daria aparência de conformidade a um domínio de terceiro.

### A2 — `verifyCredentialIntegrity` declara o que checou

`verifyCredential` foi renomeado para **`verifyCredentialIntegrity`**. O
resultado ganhou:

```ts
checked: {
  integrity: 'valid' | 'invalid' | 'not_checked'
  time: 'valid' | 'not_yet_valid' | 'expired' | 'not_checked'
  status: 'not_checked' // revogação não é checada aqui
}
```

A função aceita `now?: Date`. Sem `now`, só a janela é validada
estruturalmente (`validFrom <= validUntil`) e `checked.time = 'not_checked'`.
Com `now`, a janela é `[validFrom, validUntil)`:

- `now < validFrom` → `NOT_YET_VALID`;
- `now >= validUntil` → `EXPIRED`;
- dentro da janela → `checked.time = 'valid'`.

A ordem é integridade → tempo. Um documento adulterado retorna
`INVALID_SIGNATURE`/`checked.integrity = 'invalid'`, nunca `EXPIRED`: não se
classifica como expirado o que nem é autêntico. `verifyCredentialFromIssuer`
continua com a forma anterior de resultado (sem `checked`) e aceita `now`.

**Responsabilidade:** `verifyCredentialIntegrity` **não** consulta revogação.
Quem precisa de status usa um `CredentialStatusResolver` (ADR-0027). Misturar as
duas coisas faria a verificação de integridade depender de rede e esconderia a
diferença entre “assinatura válida” e “credencial vigente”.

### A3 — replay do deep path inclui policy e scorer

`DeepEnrichDeps` passou a receber `policyHash` (digest do YAML efetivamente
carregado) e a comparação de replay passou a exigir, além de veredito e
`evidenceSetHash`:

- `previous.policyHash === deps.policyHash`;
- `previous.scorerVersion === SCORER_VERSION`.

Uma mudança de policy/scorer sobre as MESMAS evidências agora é uma **nova
conclusão**, com novo `completed_at` (e, por C1, revogação da credencial antiga).
O teste de integração usa um `policyHash` diferente mantendo veredito e
evidências iguais e prova que o instante muda.

**Limitação conhecida (decisão pendente):** `validation.policy_hash` e
`validation.scorer_version` são imutáveis por trigger (migração 0028), porque
identificam a policy sob a qual a assertion nasceu. O worker, porém, carrega a
policy do deploy atual. Se essa policy mudar, o replay detecta a divergência e
gera novo `completed_at`, mas a linha mantém o binding antigo; a credencial nova
continua declarando a policy original. Não se alterou o guard nesta revisão.
As opções — (a) reavaliar sempre com a policy persistida na validation, (b)
permitir rebinding apenas junto de uma nova conclusão, ou (c) criar uma nova
validation/assertion — exigem ADR própria. Até lá, trocar a policy de um worker
que reprocessa validações antigas é uma operação de risco conhecido.

### A4 — `validFrom == validUntil`

A VC Data Model 2.0 Recommendation §4.9 (“Validity Period”) exige
`validFrom <= validUntil`; a igualdade é permitida. O **verificador** passou a
aceitar a igualdade (recusa apenas `validFrom > validUntil`). O **emissor**
continua estrito (`completed_at < validUntil`): uma credencial de duração zero
não afirma nada útil e não é produzida por esta biblioteca. Teste reassina um
documento com janela de duração zero e prova que ele verifica; a janela
invertida continua `INVALID_TIMESTAMP`.

### B1 — horizonte de validade da credencial

`validUntil` deixou de ser `expires_at` e passou a ser:

```text
min(
  completed_at + policy.credential_ttl_seconds,
  min(observed_at + ttl_seconds) sobre TODAS as evidências do resultado
)
```

- `credential_ttl_seconds` é opcional na policy, inteiro positivo, default
  **30 dias** (`2_592_000`). O default não altera o YAML nem o hash de policies
  já publicadas; nenhuma policy existente foi editada.
- O TTL de cada evidência (`claim_evidence.ttl_seconds`) limita a credencial: se
  uma observação que sustenta o veredito expira antes, a credencial não pode
  continuar afirmando o resultado.
- `expires_at` continua sendo o horizonte de **retenção** e não é recalculado,
  esticado nem usado como `validUntil`.
- Se o resultado for `<= completed_at`, a emissão falha com
  `VALIDITY_WINDOW_INVALID`; `buildAssertion` repete a invariante.
- Testes: `apps/api/src/services/credential-issuer.test.ts` (policy TTL, TTL
  curto de uma evidência, default, igualdade), `packages/core/src/policy.test.ts`
  (policy sem o campo e TTL inválido) e o teste de integração da janela em
  `apps/api/src/credential.int.test.ts`.

**Por que não mudar `expires_at`:** ele é o prazo de retenção do registro e do
material; esticá-lo para caber na credencial misturaria duas políticas. Se a
evidência já expirou, a resposta honesta é não emitir.

### B2 — primeira emissão determinística

Nova tabela `credential_issuance` (migração `0034_credential_issuance.sql`):

```text
validation_id  PK (uma emissão por validation)
tenant_id      FK tenant; RLS
issuer_scope   escopo público do issuer
credential_id  ponteiro público de status (o “índice” atual)
issued_at      instante da PRIMEIRA prova
created_at     auditoria
```

A tabela é **append-only** (sem UPDATE/DELETE para `app_user`, trigger de
proteção) e **não guarda o documento assinado**. Na primeira emissão, a linha e
o status `ACTIVE` são gravados na **mesma transação**. Em reemissão, a fronteira
reutiliza `issued_at` como `proof.created` e devolve o mesmo documento; o teste
de integração compara o JSON inteiro e verifica que existe uma única linha de
`credential_issuance` e uma única de `credential_status`.

Determinismo vale enquanto issuer, chave de assinatura, policy (TTL) e
`credentialId` não mudarem. Rotação de chave é uma prova nova por definição e
muda `proof.verificationMethod`; isso é intencional. A reemissão **não reativa**
uma credencial `REVOKED` (revogação é monotônica).

### C1 — credenciais superadas

Quando o deep path produz uma conclusão diferente da persistida — veredito,
`evidenceSetHash`, `policyHash`, `scorerVersion` — ou quando uma validation
`completed` volta a `partial`, as credenciais já emitidas dessa validation são
revogadas como **`superseded`** na MESMA transação da atualização do resultado.
Se a revogação falhar, a nova conclusão também não é persistida.

- `credential_status.revocation_reason` (migração `0035_credential_status_reason.sql`)
  registra `manual` (rota autenticada) ou `superseded` (deep path). A coluna não
  é exposta no endpoint público.
- A revogação só casa linhas `ACTIVE`; replay idêntico não revoga e reexecuções
  não reescrevem `revoked_at` nem o motivo. Testes cobrem replay idêntico,
  mudança de policy e regressão para `partial`.

### C2 — identidade issuer/DID ponta a ponta

O teste em `apps/api/src/credential.int.test.ts` emite pela rota real, busca o
DID Document público, **extrai a chave** e verifica a credencial com
`verifyCredentialIntegrity`; em seguida repete o caminho com
`verifyCredentialFromIssuer`. Ele confirma:

- `DID = didOfIssuer(issuer)` e `document.id === DID`;
- `document.alsoKnownAs` contém exatamente o `issuer` HTTPS da credencial;
- `credential.proof.verificationMethod` é `<issuer>#<keyId>`;
- o método DID correspondente é `<did>#<keyId>`, com `controller === did`;
- a chave `Multikey` do documento verifica a assinatura emitida pela rota.

**Não há divergência a corrigir:** `issuer` (HTTPS) e `DID` (`did:web`) são
URIs diferentes por desenho, ligadas por `alsoKnownAs`; o resolver devolve o
`id` HTTPS original para que o binding exato do verificador continue valendo. O
DID é uma porta de descoberta, não um segundo emissor.

### Riscos documentados, não implementados

- **Vocabulário reservado e posse do domínio.** Os termos `comprova:*` vivem em
  um contexto inline e a verificação é JCS (não JSON-LD), então não dependem de
  resolução. Ainda assim, o domínio do contexto e a propriedade dos termos não
  estão confirmados; publicar vocabulário reservado sem controlar o domínio é
  risco de interoperabilidade e de apropriação por terceiro.
- **Pseudônimo estável e correlação de CPF.** `subject.doc_hmac` é estável para
  o mesmo documento (por design, para permitir idempotência e continuidade).
  Isso permite correlacionar credenciais do mesmo CPF entre tenants/emissões se
  a chave HMAC for compartilhada ou vazar. Uma derivação por issuer/epoch
  reduziria a linkabilidade, mas quebraria idempotência e continuidade; é
  decisão de produto/privacidade, não uma correção local.
- **Escopo do tenant: SHA-256 vs HMAC.** `issuerScopeOf` usa SHA-256 não
  chaveado do `tenant_id`. O UUID tem entropia suficiente para não ser segredo,
  mas um vazamento de `tenant_id` permite recalcular o escopo e confirmar a
  correspondência. HMAC com segredo do servidor seria mais forte e continua
  compatível com a URL opaca; a troca muda identificadores já emitidos e exige
  migração/versionamento, por isso não foi feita nesta revisão.

### Validação executada

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (unidade + integração; Docker disponível)
- `pnpm db:fence` para as migrações `0034`/`0035`
- Testes de integração relevantes: `apps/api/src/credential.int.test.ts`,
  `apps/worker/src/modules/deep-enrich/deep-enrich.int.test.ts` e
  `apps/worker/src/deep-path.e2e.test.ts`.
