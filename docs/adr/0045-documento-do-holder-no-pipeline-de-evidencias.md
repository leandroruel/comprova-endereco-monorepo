# ADR-0045: Documento do Holder no pipeline de evidências (F4.3 → F1.2/F1.3)

## Status

Aceito (2026-11-14). Implementa o PR #73: um documento enviado pelo Holder em
resposta a uma `holder_information_request` vinculada a uma Validation passa a
participar do pipeline existente F1.1/F1.2/F1.3, preservando a rastreabilidade e
a cardinalidade 1:1 entre Validation e documento complementar.

Não cria pipeline paralelo, fila, broker nem workflow novo. Não altera score,
veredito, `weightedScore` ou política de aprovação. Não implementa OCR,
autenticação oficial, múltiplos documentos por Validation nem link do titular.

Relaciona-se com o [ADR-0035](0035-artefato-de-evidencia-tenant-scoped.md)
(artefato tenant-scoped e write-once), o
[ADR-0037](0037-intake-de-comprovante-do-cliente.md) (intake F1.1, recibo e
cardinalidade), o [ADR-0038](0038-analise-de-documento-do-cliente.md) (análise
F1.2) e o [ADR-0040](0040-verificacao-do-documento-enviado.md) (verificação
F1.3).

## Contexto

O PR #72 adicionou `holder_information_request.validation_id`, permitindo que
uma solicitação de documentos do Holder seja associada à Validation que a
originou. A F4.3 já processava os documentos enviados pelo Holder, mas apenas no
domínio do Holder:

```text
holder_information_request → holder_information_request_document
                           → evidence_artifact (holder_information_request_id)
                           → evidence_analysis
```

A F1.1/F1.2/F1.3, por sua vez, operam no domínio da Validation:

```text
validation → claim → claim_evidence (recibo customer_submitted_document)
                   → evidence_artifact (claim_evidence_id)
                   → evidence_analysis → claim_evidence (uploaded_document)
```

O mesmo documento físico precisava aparecer nos dois mundos, sem duplicar
bytes, sem reescrever o artefato e sem criar uma segunda observação de intake.
O bloqueio estrutural é a regra de fonte exclusiva de `evidence_artifact`
(`evidence_artifact_one_source_check`): o artefato pertence **ou** a
`claim_evidence_id` **ou** a `holder_information_request_id`, nunca aos dois.
Além disso, o artefato é write-once: não há UPDATE.

## Decisão

### 1. Tabela de associação aditiva, 1:1

Nasce `evidence_artifact_claim_evidence` (migration `0066`):

```text
artifact_id       uuid PRIMARY KEY
claim_evidence_id uuid NOT NULL UNIQUE
tenant_id         uuid NOT NULL
created_at        timestamptz NOT NULL DEFAULT now()
```

- PK em `artifact_id` → um artefato participa de no máximo um recibo;
- `UNIQUE (claim_evidence_id)` → um recibo tem no máximo um artefato;
- FKs compostas `(artifact_id, tenant_id)` e
  `(claim_evidence_id, tenant_id)` provam que artefato, recibo e vínculo são do
  mesmo tenant;
- `ON DELETE CASCADE` acompanha a retenção do artefato (30 dias, F4.3) e a
  erasure do `claim_evidence` (subject/validation);
- RLS FORCE com `tenant_isolation`, como as demais tabelas do grafo;
- sem UPDATE: o vínculo é imutável. DELETE existe apenas para cascata.

A tabela é a menor extensão possível: não copia bytes, não altera
`evidence_artifact`, não relaxa a check de fonte exclusiva e não introduz um
segundo `claim_evidence`.

### 2. Artefato do Holder continua pertencendo à solicitação

O artefato mantém `claim_evidence_id = NULL` e
`holder_information_request_id = <request>`. A proveniência do Holder é
preservada. A participação no pipeline da Claim é expressa **somente** pela
linha em `evidence_artifact_claim_evidence`. Isso mantém a semântica do
ADR-0035 e a auditoria de qual solicitação originou o documento.

### 3. O recibo é o mesmo da F1.1

O worker resolve `holder_information_request.validation_id`, trava a linha da
`validation` com `FOR UPDATE` (mesma ordem do intake F1.1), garante a `claim`
com as mesmas regras de `ensureClaim` (tipo derivado de `subject.docType`,
`ON CONFLICT DO NOTHING`) e cria/reutiliza a observação:

```text
source          = customer_submitted_document
checker         = customer_document_intake
checker_version = 1.0.0
stance          = unknown
strength        = 0
confidence      = 0
detail.verification.status = pending
detail.origin   = { holder_information_request_id,
                    holder_information_request_document_id,
                    evidence_artifact_id }
```

`evidence_sha256` é o hash do artefato do Holder. Nenhum resultado de análise,
aprovação de identidade ou aprovação de residência é antecipado. O recibo
continua imutável e é o mesmo conceito lógico do upload direto.

### 4. Apenas o primeiro documento ativo por Validation

A cardinalidade 1:1 Validation ↔ documento complementar é preservada por duas
barreiras:

1. `idx_claim_evidence_customer_document_uq`
   (`UNIQUE (claim_id) WHERE source = 'customer_submitted_document'`) — já
   existente desde a F1.1;
2. PK/UNIQUE da tabela de associação — um recibo tem no máximo um artefato.

Quando a solicitação tem mais de um documento, os documentos continuam sendo
processados pela F4.3 (artefato + análise), mas somente o primeiro documento
ativo (ordem determinística por `created_at`, `document_id`) é associado ao
recibo. Uma segunda solicitação para a mesma Validation reutiliza o recibo
existente; se ele já tem um artefato direto (upload F1.1) ou um vínculo, o novo
documento **não** cria segundo vínculo. O comportamento é consistente com o
`409 EVIDENCE_ALREADY_EXISTS` da F1.1.

### 5. F1.3 resolve os dois caminhos de artefato

`findNext` passa a resolver o `claim_evidence` por:

```sql
COALESCE(art.claim_evidence_id, art_link.claim_evidence_id)
```

com `LEFT JOIN evidence_artifact_claim_evidence art_link` tenant-scoped. O
upload direto F1.1 continua funcionando sem mudança e o documento do Holder
entra no mesmo candidato. A materialização F1.3, o índice de idempotência, o
backoff e o contrato público permanecem inalterados.

### 6. Idempotência e concorrência

- A `validation` é travada antes de criar claim/recibo, serializando upload
  direto e submissão do Holder para a mesma Validation.
- `claim`, recibo, artefato e vínculo usam `ON CONFLICT DO NOTHING` seguido de
  releitura, cobrindo replay de outbox, retry e duas execuções concorrentes.
- A unicidade é garantida pelo banco (índices e PKs), não apenas por checagem
  na aplicação.
- Reprocessar o mesmo evento não duplica artefato, análise, recibo nem vínculo.

### 7. Solicitações sem vínculo continuam como antes

Se `validation_id` é `NULL`, não existe, ou a Validation foi removida por
erasure, o worker não materializa claim/recibo/vínculo. O documento continua
sendo processado como documento do Holder (artefato + análise), sem ressuscitar
evidência da Validation. A ausência é logada apenas com ids e razão técnica.

## Alternativas rejeitadas

1. **Preencher `evidence_artifact.claim_evidence_id` no artefato do Holder.**
   Viola `evidence_artifact_one_source_check`, perde a proveniência da
   solicitação e exigiria UPDATE em artefato write-once.
2. **Copiar bytes para um segundo artefato ligado ao recibo.**
   Duplica PII e storage, cria dois hashes do mesmo conteúdo e quebra a
   rastreabilidade de qual objeto físico foi submetido.
3. **Criar uma segunda `claim_evidence` só para o Holder.**
   Duplicaria o recibo, permitiria duas contagens no `evidence_summary` e
   conflitaria com a cardinalidade 1:1 da F1.1.
4. **Criar uma fila/worker específico para o pipeline da Validation.**
   O outbox transacional existente e o worker F4.3 já entregam a submissão; uma
   fila nova adicionaria um segundo caminho de consistência sem necessidade.
5. **Relaxar a check de fonte exclusiva.**
   A regra é a garantia de que todo artefato tem uma origem única e auditável.
   A associação é uma relação adicional, não uma segunda origem.
6. **Materializar todos os documentos da solicitação como evidências.**
   Expande a cardinalidade além do decidido na F1.1/F1.3 e muda o modelo de
   score. Fica para uma decisão futura explícita.

## Consequências

- O documento do Holder passa a gerar verificação F1.3 no claim da Validation
  sem mudar `score`, `confidence`, `weightedScore` ou veredito.
- O recibo F1.1/F4.3 continua `pending` e imutável; a F1.3 cria a linha
  `uploaded_document` separada, como já decidido no ADR-0040.
- `evidence_summary` pode contar recibo e verificação como observações
  distintas, igual ao fluxo de upload direto.
- Documentos adicionais da mesma solicitação continuam apenas no domínio do
  Holder. Uma futura expansão multi-documento exigirá decisão própria.
- A retenção do artefato do Holder continua sendo 30 dias (F4.3), diferente do
  `validation.expires_at` da F1.1. O vínculo é apagado em cascata com o
  artefato ou com o `claim_evidence`.
- A `validation` é particionada por `created_at` e não possui FK direta a partir
  da solicitação; a existência e o tenant são validados na transação com lock.
  O vínculo com o recibo usa FKs compostas para o tenant.

## Segurança e LGPD

- O vínculo não contém PII: apenas ids técnicos, tenant e timestamp.
- O `detail.origin` guarda ids de solicitação/documento/artefato; não guarda
  hash de identidade, nome, endereço, CEP, CPF/CNPJ nem bytes.
- `holder.documentHash` nunca é comparado com `subject.docHmac`; a identidade
  operacional do Holder e a identidade do subject permanecem separadas.
- Logs usam `request_id`, `tenant_id`, `validation_id`, `document_id` e nome de
  classe de erro. Não logam conteúdo, filename nem PII.
- RLS FORCE e FKs compostas impedem vínculo cross-tenant. A fila atravessa
  tenants com o pool administrativo, mas toda escrita do grafo usa
  `withTenant`.
- A retenção/erasure apaga o vínculo por cascata, sem deixar referência órfã.

## Testes

`apps/api/tests/holder-evidence-integration.int.test.ts` cobre:

- materialização do recibo pendente (`unknown/0/0`), vínculo 1:1 e artefato
  ainda pertencente à solicitação;
- F1.2 sobre o mesmo artefato e F1.3 materializando `uploaded_document` com
  `stance = unknown`;
- duas solicitações para a mesma Validation mantendo um único recibo/vínculo;
- replay de outbox e retry sem duplicar artefato, análise, recibo ou vínculo;
- duas execuções concorrentes sem violar a cardinalidade;
- separação Holder × Subject e ausência de aprovação automática de residência;
- solicitação sem vínculo e Validation inexistente sem materialização;
- evento com tenant divergente sem processamento;
- RLS por tenant e rejeição de um segundo vínculo pelo UNIQUE do banco.
