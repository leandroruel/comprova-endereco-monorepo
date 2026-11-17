# Diagnóstico e Proposta de Domínio — PR #72

Repositório: `leandroruel/comprova-endereco-monorepo`
Branch: `feat/pr-1-holder-request-validation-association`
Etapa: **Diagnóstico (apenas leitura, sem alterações de código)**

---

## 1. Estado atual do fluxo documental

### 1.1. Como o Subject é criado

No `apps/api/src/services/fastpath.ts`, função `runFastPath` (linhas 653-678):

1. O backend recebe `document.type` (CPF/CNPJ) e `document.value` do Verifier.
2. Calcula `docHmac = HMAC-SHA256(sha256('doc-hmac:' + API_KEY_PEPPER), "CPF:{digits}")`.
3. Insere ou recupera um `subject` com `(tenantId, docType, docHmac)` — índice único `subject_tenant_hmac_uq`.
4. O `subject.docHmac` é **gerado exclusivamente pelo backend**, nunca vem do cliente.

### 1.2. Como a Validation é criada

No mesmo `runFastPath` (linhas 808-838):

1. Cria `validation` com `subjectId` vinculado ao subject criado/recuperado acima.
2. Grava `apiKeyId` (quando autenticado por API Key M2M) e `userId` (quando autenticado por sessão de usuário).
3. O `userId` vem do parâmetro do controller `validations.controller.ts` linha 240 (`userId: string | null | undefined`) e é repassado para `runFastPath`.
4. Grava `claim` vinculado à validation e ao subject.

### 1.3. Como o Holder é criado

No `apps/api/src/modules/holder/holder.service.ts`, função `createHolder` (linhas 29-109):

1. O Verifier envia `externalReference`, `name`, `documentHash`, `documentType`.
2. O `documentHash` é **fornecido pelo cliente** via POST `/holders`, validado apenas por regex `/^[0-9a-f]{64}$/` (holder.routes.ts linha 62).
3. Não há validação de que esse hash corresponda a qualquer documento real ou ao titular da Validation.
4. O `holder.documentHash` é persistido como texto puro, sem chave secreta do sistema.

### 1.4. Como o link/token do Holder funciona

No `apps/api/src/modules/holder/holder-access.service.ts`:

1. `resolveToken` (linha 306): resolve o token opaco via função `SECURITY DEFINER` `app_resolve_holder_access_token`, retornando `tokenId, tenantId, holderId, holder_information_request_id, first_accessed_at`.
2. `authorizeInTx` (linha 110): valida que o token pertence ao tenant, holder e solicitação informados, usando `FOR UPDATE` para serialização.
3. `submit` (linha 962): transição atômica `pending/in_progress → completed`, emite evento `holder_submission.processing_requested` no outbox com `holder_information_request_id` e `tenant_id`.

### 1.5. Como o Worker processa a submissão

No `apps/worker/src/modules/holder-submission-processing/holder-submission-processing.service.ts`:

1. Consome o outbox com `aggregate = 'holder_information_request'` e `event_type = 'holder_submission.processing_requested'`.
2. Cria `evidence_artifact` vinculado à `holder_information_request` (não à claim/validation).
3. Cria `evidence_analysis` pendente.
4. Não há ligação com a `validation` ou `claim` do Verifier.

### 1.6. Autenticação e autorização do Verifier

No `apps/api/src/plugins/auth.ts` e `scope.ts`:

- **Sessão de usuário (Better Auth):** `apiKeyId: null`, `keyType: 'user'`, escopos vazios. O `userId` vem da sessão e é repassado via parâmetro do controller.
- **API Key M2M (Bearer):** `apiKeyId` preenchido, `keyType: 'm2m'`, exige `verify:m2m`.
- **API Key user (Bearer):** não é aceita para endpoints Holder/KYC (`requireSessionOrM2M` linha 289-291).

---

## 2. Papéis das entidades

### Subject

**Quem é:** É o sujeito de uma Validation, criado exclusivamente pelo backend durante o fluxo de validação de endereço (fast path). Representa o documento (CPF/CNPJ) informado pelo Verifier na requisição de validação.

**É necessariamente a pessoa cuja residência está sendo validada?** Sim. O Subject é criado a partir do `document.type` e `document.value` enviados na requisição `POST /v1/validations`. O `docHmac` é o HMAC desse documento.

**Quais dados de identidade estão associados:** `subjectId`, `tenantId`, `docType`, `docHmac` (HMAC-SHA256 com chave interna do sistema), `docEnc` (opcional). Não armazena o documento em texto puro.

**Em que momento e por quem:** Criado automaticamente pelo backend durante `POST /v1/validations`, nunca informado diretamente pelo cliente. O Verifier informa o documento (CPF/CNPJ) e o sistema gera o Subject.

### Holder

**Quem é:** É um titular de dados e documentos cadastrado por uma organização Verifier para processos de KYC. Criado via `POST /holders` com `externalReference`, `name`, `documentHash`, `documentType`.

**É necessariamente o próprio Subject?** Não. Não há qualquer mecanismo de vinculação entre `holder` e `subject` no modelo atual. São entidades independentes.

**Pode ser um representante, familiar ou terceiro?** O modelo atual não faz essa distinção. O `documentHash` do Holder é qualquer string hex de 64 caracteres fornecida pelo cliente, sem validação de correspondência com qualquer pessoa real.

**Qual é a responsabilidade do Holder no fluxo documental:** Recebe um `holder_information_request` do Verifier, envia documentos (via `holder-access`), e submete a solicitação. A submissão dispara o processamento documental (F4.3) via worker, que cria `evidence_artifact` e `evidence_analysis` vinculados à solicitação do Holder — mas não à `validation`/`claim` do Verifier.

### Titular do comprovante

**Como será identificado:** Atualmente não é identificado. O comprovante enviado pelo Holder é armazenado como `evidence_artifact` (arquivo físico) e `evidence_analysis` (resultado da extração via unpdf/Marker). Não há extração de titular do documento no MVP atual.

**O titular do documento precisa ser o Subject?** Não há mecanismo para verificar isso. O Subject é criado a partir do documento (CPF/CNPJ) informado na Validation, enquanto o comprovante do Holder é um arquivo separado sem extração de titular.

**O documento pode estar em nome de outra pessoa?** Sim, atualmente não há nenhuma validação que impeça isso.

**O sistema atual tem capacidade de identificar o titular do comprovante?** Não. O `evidence_analysis` extrai campos (endereço, titular) via OCR/local text layer, mas não há validação de que o titular do comprovante corresponda ao Subject da Validation.

---

## 3. Problemas identificados

| ID  | Problema                                                            | Local                                                                                                                | Tipo                                      |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P1  | **Não há vinculação de identidade entre Holder e Subject**          | `holder` e `subject` são entidades independentes, sem FK nem campo comum                                             | Decisão de domínio                        |
| P2  | **`documentHash` (holder) e `docHmac` (subject) são incomparáveis** | `holder.documentHash` fornecido pelo cliente (regex apenas); `subject.docHmac` gerado pelo backend com chave interna | Técnica                                   |
| P3  | **Auditoria usa `session:unknown` quando `apiKeyId` é null**        | `fastpath.ts` linha 895, `validations.service.ts` linha 292, `subjects.service.ts` linha 95                          | Técnica                                   |
| P4  | **Migration 0064 documenta lock incorretamente**                    | `0064_holder_request_validation_link.sql`                                                                            | Documentação                              |
| P5  | **Não há FK em `holder_information_request.validation_id`**         | `0064` + schema Drizzle                                                                                              | Técnica (justificada por particionamento) |

---

## 4. Cenários de identidade

### Cenário 1: Holder e Subject são a mesma pessoa

- **Situação:** O titular da Validation envia seus próprios comprovantes.
- **Status atual:** Não há verificação. O Holder pode ser qualquer pessoa com qualquer `documentHash`.
- **Deve ser:** Aceito apenas se a identidade for comprovada (mesmo titular).

### Cenário 2: Holder é diferente do Subject, mas autorizado

- **Situação:** Um familiar ou representante envia documentos em nome do titular.
- **Status atual:** Não há mecanismo de representação.
- **Deve ser:** Requer relação explícita e justificada.

### Cenário 3: Comprovante no nome do Subject

- **Situação:** A conta de luz está no nome do Subject.
- **Status atual:** Não há extração de titular do comprovante. Não há como verificar.
- **Deve ser:** Pendente de extração documental (OCR) + comparação com Subject.

### Cenário 4: Comprovante no nome do Holder

- **Situação:** A conta está no nome da pessoa que enviou (Holder).
- **Status atual:** Não há extração de titular do comprovante.
- **Deve ser:** Mesmo que o cenário 3 — requer extração e comparação.

### Cenário 5: Comprovante em nome de terceiro (cônjuge/familiar)

- **Situação:** A conta está no nome de outra pessoa.
- **Status atual:** Não há mecanismo de detecção.
- **Deve ser:** Requer política explícita de terceiros + evidência de relacionamento.

### Cenário 6: Titular do comprovante não identificável

- **Situação:** Documento sem dados de titular extraíveis.
- **Status atual:** Não há detecção.
- **Deve ser:** Marcado como inconclusivo, não aprovado automaticamente.

### Cenário 7: Documento com informações conflitantes

- **Situação:** Endereço/titular do comprovante diverge dos dados da Validation.
- **Status atual:** Não há comparação automática entre comprovante e Validation.
- **Deve ser:** Marcado como contraditório, não aprovado automaticamente.

---

## 5. Política recomendada para o MVP

**Princípio fundamental:** Associar um Holder a uma Validation **não comprova identidade**. Comprovar identidade **não comprova residência**. Identificar o titular de um comprovante **não comprova** que ele reside com o Subject.

### Regras explícitas:

1. **Associação operacional (Holder → Validation):** Permitida. É um vínculo administrativo que indica "este Holder está enviando documentos para esta Validation". Não implica identidade.

2. **Identidade do Holder:** Não é verificada automaticamente contra o Subject no MVP. O `documentHash` do Holder não é fonte confiável de identidade (fornecido pelo cliente, sem chave do sistema).

3. **Comprovantes em nome de terceiros:** Não são automaticamente válidos nem automaticamente inválidos. Requerem análise de evidência documental (extração de titular do comprovante + comparação com Subject + política de terceiros) — que **não existe no MVP atual**.

4. **Separação de conceitos:**
   - Associação Holder → Validation: vínculo operacional.
   - Identidade do Holder: não verificada no MVP.
   - Titular do comprovante: não extraído no MVP.
   - Comprovação de residência: não executada no MVP (depende de extração documental + comparação de endereço com o Subject).

---

## 6. Estratégia de identidade técnica

**Não usar `holder.documentHash` para comparação.** Ele é fornecido pelo cliente, sem chave do sistema, sem algoritmo controlado.

**Se o domínio exigir identidade comum:** O backend deveria gerar um HMAC com chave interna para o documento do Subject (já faz: `docHmac`) e oferecer um mecanismo para o Verifier informar o documento do Holder usando a mesma chave. Mas isso requer decisão de domínio sobre qual documento serve de identidade e como o Verifier o informa.

**Recomendação para o MVP:** Manter a associação operacional `holder_information_request.validation_id` sem validação de identidade. Documentar explicitamente que:

- A associação não comprova identidade.
- O processamento documental (PR 2) deve avaliar evidências de forma independente.
- Qualquer comparação de identidade entre Holder e Subject requer decisão de domínio e mecanismo de HMAC comum.

---

## 7. Impacto no PR #72

### Alterações ainda necessárias:

#### 7.1. Auditoria de Validation criada por sessão (P1)

**Problema:** `fastpath.ts` linha 895 usa `session:${tenant.userId ?? 'unknown'}`. Quando `userId` é null/undefined, grava `session:unknown`, mascarando operações sem identificação real.

**Correção:**

- `validation.create`: quando `apiKeyId` é null (sessão), o `userId` deveria ser obrigatório. Se não houver `userId`, não deveria gravar `session:unknown`.
- `validation.contested`: `validations.service.ts` linha 292 usa `api-key:${apiKeyId}` sem tratar null.
- `subject.erasure`: `subjects.service.ts` linha 95 usa `api-key:${apiKeyId}` sem tratar null.

**Ação:** Alterar para rejeitar ou usar identificação real explícita. Não usar `'unknown'`.

#### 7.2. Documentação da migration 0064 (P2)

**Problema:** A migration afirma que `CREATE INDEX` adquire `ACCESS EXCLUSIVE`. Isso está incorreto para `CREATE INDEX` convencional (usa `SHARE`). O `ACCESS EXCLUSIVE` vem do `ALTER TABLE ... ADD COLUMN` e persiste durante toda a transação do runner, incluindo durante a criação dos índices.

**Correção:** Atualizar o comentário da migration para descrever corretamente:

- `ALTER TABLE ... ADD COLUMN` → `ACCESS EXCLUSIVE` (bloqueia leituras e escritas até o commit).
- `CREATE INDEX` convencional → `SHARE` (bloqueia escritas, permite leituras).
- Como o runner executa tudo em uma transação, o `ACCESS EXCLUSIVE` do ALTER TABLE persiste durante os índices.

#### 7.3. Índices SQL/Drizzle (P2)

**Status:** Já alinhados. Migration e schema Drizzle usam o mesmo nome `holder_information_request_validation_idx` para o índice composto e o mesmo índice parcial `holder_information_request_validation_request_idx`. Não há alteração necessária.

#### 7.4. Integridade referencial de `validation_id` (P2)

**Status:** Sem FK direta devido ao particionamento de `validation` (PK composta particionada por `created_at`). PostgreSQL não permite FK para parte de PK particionada. A aplicação garante consistência por tenant no momento da associação (validação no `createHolderInformationRequest`).

**Decisão:** Manter a decisão documentada. Não introduzir FK incompatível com o particionamento.

---

## 8. Impacto no próximo PR (processamento documental)

O próximo PR (processamento documental do Holder) consumirá:

1. `holder_information_request.validation_id` — para saber a qual Validation o Holder está vinculado.
2. `evidence_artifact` e `evidence_analysis` criados pelo worker F4.3 — vinculados à `holder_information_request`, não à claim/validation.
3. **Não haverá** verificação automática de que o titular do comprovante corresponde ao Subject da Validation, pois não há mecanismo de identidade comum.

**Recomendação:** O próximo PR deve tratar o comprovante do Holder como evidência independente, sem assumir que o titular do comprovante é o Subject da Validation. A comparação de endereço/titular deve ser feita como verificação documental, não como verificação de identidade do titular.

---

## 9. Migração e compatibilidade

- **Migration 0064:** Aditiva, segura. Coluna `validation_id` nullable. Não quebra solicitações existentes.
- **Registros existentes:** Todos os `holder_information_request` existentes terão `validation_id = NULL`. Isso é intencional (compatibilidade).
- **Não há dados a migrar:** Não há necessidade de preencher `validation_id` para registros existentes.

---

## 10. Testes necessários

### Testes de identidade (quando a decisão de domínio for estabelecida):

- Mesmo titular e mesmo tenant: associação permitida.
- Titulares diferentes no mesmo tenant: associação rejeitada.
- Validation de outro tenant: associação rejeitada.
- Validation inexistente: associação rejeitada.
- Identidade ausente ou não verificável: associação rejeitada.
- Nenhum documento pessoal em logs ou mensagens de erro.

### Testes de auditoria (já implementados no código, precisam de teste):

- Criação por API Key registra `api-key:<id>`.
- Criação por sessão registra `session:<userId>` (não `session:unknown`).
- Operação batch sem usuário registra identificação explícita.
- Ausência de `userId` não é confundida com sessão autenticada.

---

## 11. Critério de conclusão

Esta etapa estará concluída quando:

1. **A associação Holder ↔ Validation tiver uma regra de identidade explícita** (ou a decisão explícita de NÃO verificar identidade no MVP, documentada como tal).
2. **Não seja possível associar silenciosamente titulares diferentes sem uma regra de domínio explícita.**
3. **Dados pessoais não sejam armazenados em texto puro para viabilizar comparação.**
4. **A auditoria identifique corretamente operações por API Key, sessão e batch.**
5. **Os índices SQL e Drizzle estejam consistentes.**
6. **A documentação da migration descreva corretamente os locks do PostgreSQL.**
7. **O risco operacional da migration tenha sido avaliado e documentado.**
8. **Os testes relevantes passem.**
9. **O CI completo passe.**
10. **Nenhuma funcionalidade fora do escopo tenha sido implementada.**

---

## Decisão pendente

**Esta etapa não está concluída.** Preciso da sua decisão sobre:

> O Comprova aceitará comprovantes de residência emitidos em nome de terceiros (cônjuge, familiar, outra pessoa)? Se sim, sob quais condições e com quais evidências?

Com essa resposta, consigo definir:

- Se a associação Holder → Validation requer verificação de identidade.
- Que mecanismo técnico usar (HMAC comum, relação explícita de terceiros, ou associação operacional sem identidade).
- Quais testes escrever para validar a regra de domínio.

**Não implementarei código até essa decisão ser estabelecida.**
