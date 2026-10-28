# Arquitetura de evidências e verificação fiscal (alvo)

> **Status:** proposta de arquitetura, 2026-10-22, atualizada em 2026-10-28.
> **F0.1 (artefato tenant-scoped), F1.1 (intake do comprovante), F1.2
> (análise/extração do documento), F1.3 (verificação do documento enviado),
> F2.1 (contrato `FiscalAdapter` e materialização da observação fiscal), F2.2a
> (referência fiscal normalizada), a parte física da F2.2b (decodificação local
> do QR) e a primeira consulta NF3-e via SVRS em produção para RS/SP estão
> implementados**; OCR de imagem, expansão fiscal e as demais fontes continuam
> não implementados.
> Este documento descreve o alvo e o que já existe para reaproveitar. As decisões
> estão registradas em [ADR-0033](adr/0033-verificacao-de-evidencias-por-adaptadores.md),
> [ADR-0034](adr/0034-consulta-a-fontes-fiscais-endpoints-oficiais.md),
> [ADR-0035](adr/0035-artefato-de-evidencia-tenant-scoped.md),
> [ADR-0037](adr/0037-intake-de-comprovante-do-cliente.md),
> [ADR-0038](adr/0038-analise-de-documento-do-cliente.md),
> [ADR-0039](adr/0039-extracao-de-pdf-com-unpdf.md),
> [ADR-0040](adr/0040-verificacao-do-documento-enviado.md) e
> [ADR-0041](adr/0041-contrato-fiscal-adapter.md).
> **Estado atual:** [`architecture.md`](architecture.md).
> **Prioridades:** [`roadmap.md`](roadmap.md).

## 1. Escopo

O Comprova valida **uma afirmação de endereço** (`claim`) sobre um `subject`
(CNPJ/CPF) e um `target` (endereço). Hoje as evidências vêm de registro público
(Receita, CNEFE, CEP) e, no deep path, de fachada via VLM. O alvo é aceitar mais
duas famílias de evidência:

1. **Documento do cliente** (comprovante de endereço: conta de luz, água,
   telefone, contrato), enviado por upload ou pelo titular.
2. **Consulta a fonte oficial** (NF3e hoje; NFAg-e e outras no futuro).

O ponto central: **essas duas famílias não são um novo domínio**. Elas produzem
observações que se encaixam no modelo existente `validation → claim →
claim_evidence → evidence`. O contrato de verificação e a taxonomia de resultado
já existem; permanecem como evolução OCR, cobertura fiscal e operação comercial.
A análise intermediária da F1.2 precisou de uma única
tabela append-only (`evidence_analysis`) porque `claim_evidence` é imutável e
`evidence_artifact` é write-once; a decisão e o contrato estão no
[ADR-0038](adr/0038-analise-de-documento-do-cliente.md).

## 2. Princípios

1. **Fonte é fonte; evidência é evidência.** O adaptador fala com o mundo e
   devolve um resultado tipado. A persistência continua sendo `claim_evidence`
   (observação de verificação) + o material: `evidence` para captura pública,
   `evidence_artifact` para PII tenant-scoped (F0.1) e `evidence_analysis` para
   a extração intermediária da F1.2 (append-only, uma linha por versão).
2. **Autenticidade do documento ≠ correspondência do endereço ≠ vínculo com o
   titular.** São três dimensões independentes; colapsar em um booleano produz
   conclusão errada.
3. **Indisponibilidade não é contradição.** Fonte fora do ar, timeout, resposta
   ambígua ou formato desconhecido resultam em `unknown`, nunca `contradicts`.
4. **Nunca buscar URL fornecida pelo usuário.** O QR Code identifica o
   autorizador; a URL de consulta vem de uma allowlist no servidor.
5. **Histórico é imutável.** Uma atualização cria nova validação; não reescreve
   a antiga nem reassina credencial.
6. **Sem abstração sem segunda implementação.** O contrato nasce com duas
   famílias reais (upload e fiscal) e não com "plug-ins genéricos".

## 3. Responsabilidades e onde vivem

| Responsabilidade      | Hoje                                                                                                                            | Alvo                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Entrada de evidência  | HTTP autenticado + storage privado (F1.1); street view no worker                                                                | Igual                                     |
| Identificação do tipo | Assinatura de PDF/JPEG/PNG no intake (F1.1)                                                                                     | Estrutura/OCR e XML/QR (F1.2/F2)          |
| Extração de campos    | PDF via `unpdf`/PDF.js no worker (F1.2); campos só por rótulo explícito; VLM só fachada                                         | OCR de imagem; parse no adaptador fiscal  |
| Verificação do upload | Comparadores puros + worker (`evidence-verification.ts`, F1.3)                                                                  | Igual                                     |
| Consulta externa      | Providers de endereço com URL fixa; NF3-e SVRS em produção para RS/SP (F2.2b)                                                   | Adaptadores com allowlist (F2)            |
| Normalização          | Checkers T0/T1/T2 + normalização de endereço/titular (F1.2/F1.3)                                                                | Normalizador por fonte                    |
| Persistência          | `claim_evidence` + `evidence`/`evidence_artifact` + `evidence_analysis` + `evidence_verification_attempt` (F0.1/F1.1/F1.2/F1.3) | Igual + evidência de fonte fiscal (F2)    |
| Avaliação             | `evaluateClaim` / `weightedScore`                                                                                               | Igual + metadados de independência        |
| Explicação            | `assessment` / `explanation_detail`                                                                                             | Igual                                     |
| Credencial            | `@comprova/credential`                                                                                                          | Igual (credencial é saída, não evidência) |

## 4. Contrato conceitual do verificador

> Contrato **do verificador**. A análise F1.2 tem contrato próprio
> (`DocumentAnalysisResult`, ADR-0038) e nunca produz `authentic`, `matches` ou
> `differs`. O contrato puro e a implementação para `uploaded_document` estão na
> F1.3 (`packages/core/src/evidence-verification.ts`). A F2.1 adiciona o
> contrato `FiscalAdapter` (`packages/core/src/fiscal-verification.ts`) e a
> materialização em `claim_evidence`; a primeira consulta real NF3-e via SVRS em
> produção para RS/SP está implementada na F2.2b.

```ts
type EvidenceSourceKind = 'uploaded_document' | 'fiscal_nf3e' | 'fiscal_nfag' | 'public_registry'

type VerificationMethod =
  | 'content_extraction' // OCR/PDF do documento enviado
  | 'official_qr_consultation' // consulta ao autorizador
  | 'official_xml_signature' // validação criptográfica do XML
  | 'manual_review'

type DocumentOutcome =
  | 'authentic' // consulta oficial confirmou a existência/integridade
  | 'not_found' // consulta concluiu e não localizou
  | 'invalid' // estrutura/assinatura/chave inválida de forma definitiva
  | 'inconclusive' // respondeu, mas sem dados suficientes
  | 'unavailable' // fonte indisponível/timeout/erro
  | 'unsupported' // tipo/método/autorizador não suportado

type MatchOutcome = 'matches' | 'differs' | 'not_extracted'

interface EvidenceVerificationResult {
  readonly source: {
    readonly kind: EvidenceSourceKind
    readonly id: string // ex.: 'nf3e:svrs', 'upload:pdf'
    readonly authority: string | null // autorizador, quando fiscal
    readonly environment: 'production' | 'homologation' | 'local'
  }
  readonly method: VerificationMethod
  readonly document: DocumentOutcome
  readonly address: MatchOutcome
  readonly holder: MatchOutcome

  readonly documentRef: string | null // chave de acesso, protocolo, hash
  readonly extractedAt: Date
  readonly queriedAt: Date | null
  readonly issuedAt: Date | null // competência/emissão do documento
  readonly limitations: readonly string[]
  readonly errorCodes: readonly string[]

  readonly artifact: {
    readonly sha256: string
    readonly storageRef: string | null
  } | null
  readonly audit: {
    readonly requestedUrl: string | null
    readonly resolvedIp: string | null
    readonly responseStatus: number | null
    readonly responseSha256: string | null
  }
}
```

### 4.1 Por que três dimensões

| Dimensão   | Pergunta                                       | Exemplo                        |
| ---------- | ---------------------------------------------- | ------------------------------ |
| `document` | O documento existe e é autêntico?              | NF3e localizada no autorizador |
| `address`  | O endereço do documento é o endereço afirmado? | CEP/logradouro/número batem    |
| `holder`   | O titular do documento é o `subject`?          | Conta no nome do CNPJ/CPF      |

Uma NF3e autêntica no nome de outra empresa confirma que **o endereço existe**
e que **a concessionária atende ali**, mas não que o `subject` ocupa o imóvel.
Sem separar `holder`, o produto conclui "CONFIRMED" indevidamente. O mesmo vale
para um comprovante autêntico com endereço antigo: `document=authentic`,
`address=differs`.

### 4.2 Mapeamento para `claim_evidence.stance`

A decisão de stance é do **adaptador de política**, não da fonte:

| Situação                                       | `stance`                                                                                                  | Observação                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `document=authentic` e `address=matches`       | `supports`                                                                                                | Evidência forte de existência/uso do endereço    |
| `document=authentic` e `address=differs`       | `contradicts`                                                                                             | Documento real aponta outro endereço             |
| `document=authentic` e `address=not_extracted` | `unknown`                                                                                                 | Autenticidade sem informação de endereço         |
| `document=not_found`                           | `contradicts` **só** se o autorizador era o correto e a consulta foi conclusiva; caso contrário `unknown` | "Não achei" não é prova de fraude                |
| `document=invalid`                             | `contradicts` quando a invalidade é definitiva; senão `unknown`                                           | Ex.: chave inexistente no autorizador competente |
| `document=inconclusive`                        | `unknown`                                                                                                 | Nunca contradiz                                  |
| `document=unavailable`                         | `unknown`                                                                                                 | Nunca contradiz                                  |
| `document=unsupported`                         | `unknown`                                                                                                 | Nunca contradiz                                  |

Regra dura: **`unavailable`, `inconclusive` e `unsupported` não podem virar
`contradicts` em nenhuma policy.** Isso deve ser garantido por teste, não por
convenção.

Na F1.3, o documento enviado não é autenticado: quando a extração termina, a
dimensão `document` fica `inconclusive` (um PDF legível não prova autenticidade)
e a política mantém `stance = unknown`, mesmo que `address`/`holder` sejam
`matches` ou `differs`. A comparação continua observável no `detail` e no
`GET`, mas não vira `supports`/`contradicts` até existir uma fonte que autentique
o documento (F2) ou uma decisão de scoring (F3).

### 4.3 Uma observação por fonte

Recomendação: **uma linha em `claim_evidence` por consulta a uma fonte**, com as
três dimensões no `detail` (jsonb). Não criar três linhas (autenticidade,
endereço, titular) porque:

- as três vêm da mesma fonte e não são independentes; somá-las no score é
  contar a mesma prova três vezes;
- `claim_evidence` é imutável e auditável por linha;
- o peso por checker já existe em `policies/*.yaml` (`weights`).

Isso vale para a **verificação**. A extração F1.2 não é uma segunda observação
de `claim_evidence`: é uma linha em `evidence_analysis`, consumida pelo
verificador. Na F1.3, a verificação é materializada em uma **linha própria** de
`claim_evidence` (`source = uploaded_document`), enquanto a linha F1.1
(`customer_submitted_document`) permanece como recibo imutável do intake.

A linha de verificação **não emite `signal`** nesta etapa. Portanto a mesma
prova não é contada duas vezes no `weightedScore` e o veredito não muda. A
leitura corrente é a verificação mais recente; versões antigas continuam
disponíveis para auditoria. A decisão completa está no
[ADR-0040](adr/0040-verificacao-do-documento-enviado.md).

Se um dia for necessário ponderar endereço e titular separadamente, isso é uma
mudança de **scoring** (`SCORER_VERSION`), não de schema.

## 5. Modelo de dados: reuse primeiro

| Necessidade                 | Onde cabe hoje                                                       | Extensão mínima                            |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Extração intermediária      | `evidence_analysis.result` (F1.2)                                    | Tabela append-only por versão (ADR-0038)   |
| Tipo de documento           | `evidence_analysis.result.document.kind` + `claim_evidence.detail`   | Vocabulário controlado (sem migração)      |
| Fonte/autorizador           | `claim_evidence.source` + `detail`                                   | Convenção de nome (`nf3e:svrs`)            |
| Método                      | `detail.verification.method`                                         | Sem migração                               |
| Resultado por dimensão      | `detail.verification.*`                                              | Sem migração                               |
| Artefato                    | `evidence` (público) ou `evidence_artifact` (PII, F0.1)              | `evidence_artifact` já entregue (ADR-0035) |
| Vínculo observação↔artefato | `claim_evidence.evidence_id` / `evidence_artifact.claim_evidence_id` | Já existe                                  |
| Data do documento           | `detail.issued_at`                                                   | Coluna só se a policy precisar consultar   |
| Confiança                   | `strength`, `confidence`, `observed_at`, `ttl_seconds`               | Já existe                                  |
| Histórico                   | `validation` imutável + `created_at`                                 | `supersedes_validation_id` quando F4       |
| Uso faturável               | `usage_event`                                                        | Idempotência + vocabulário de `kind` (F3)  |

**Não criar** `document`, `document_field`, `verification_attempt` ou
`fiscal_source` antes de existir consulta real e necessidade de query. O
`detail` jsonb continua sendo o lugar de evolução da **verificação**; ele já é
usado pelos checkers. A exceção mínima é `evidence_analysis` (F1.2), justificada
no ADR-0038: a extração precisa ser versionada e não pode reescrever
`claim_evidence` nem `evidence_artifact`.

### 5.1 O `evidence` global e o artefato de PII (decidido)

`evidence` não tem `tenant_id` nem RLS (`0005_validation.sql`, `0007_rls.sql`,
`0008_grants.sql`). Para imagem pública de fachada isso é adequado: o artefato
não é PII e o vínculo com o tenant está em `claim_evidence`. Para um comprovante
de cliente, o artefato **é** dado pessoal.

Decisão (F0.1/[ADR-0035](adr/0035-artefato-de-evidencia-tenant-scoped.md)):
**opção B** — `evidence_artifact` tenant-scoped, com `evidence` intocada.

```text
claim
  └── claim_evidence (observação, tenant-scoped)
          ├── evidence          (descritor material legado, global)
          └── evidence_artifact (PII, tenant-scoped, write-once)
```

A implementação usa FK composta `(claim_evidence_id, tenant_id)`, RLS FORCE,
`storage_key` no namespace `tenants/<tenant>/evidence/<artifact>`, `sha256`/
tamanho/content-type validados e nenhum binário no Postgres. A retenção apaga o
objeto antes da linha, antes do grafo da validation.

Alternativas rejeitadas: `evidence.tenant_id` + RLS (migra tabela populada e
mistura público com PII) e `evidence_artifact` com FK para `evidence` (permitiria
referência cross-tenant, porque `evidence` é global).

A cadeia conceitual fica explícita:

```text
Artifact (bruto) → Analysis (extração não confiável) → Evidence (observação de verificação)
                 → Assessment (avaliação) → Credential (assinada)
```

`artifact` não é `analysis` nem `credential`: o primeiro é matéria-prima com
retenção curta; a segunda é uma leitura versionada e não confiável; a última é a
saída verificável da avaliação.

### 5.2 Intake do comprovante do cliente (F1.1, implementado)

Contrato entregue em
[ADR-0037](adr/0037-intake-de-comprovante-do-cliente.md):

- **Rota:** `POST /v1/validations/:id/evidence`, autenticada por API key e
  `validate:write`. O tenant vem só da key; validação de outro tenant é `404`.
- **Multipart:** exatamente um arquivo no campo `file`; campos de texto e
  múltiplos arquivos são rejeitados. O limite default é 50 MiB (o mesmo de
  `evidence_artifact`), configurável para baixo por `EVIDENCE_MAX_BYTES`. O
  parser aplica `fileSize` durante o streaming e o handler rejeita
  `Content-Length` claramente acima do limite antes de ler. Como o arquivo é
  bufferizado para o storage, um semáforo por processo
  (`EVIDENCE_MAX_CONCURRENCY`, default 4, máximo 16) limita quantos uploads
  ficam em voo antes de `part.toBuffer()`; o limite é por processo, não global
  entre réplicas.
- **Tipo por conteúdo:** a allowlist é PDF (`%PDF-`), JPEG (`FF D8 FF`) e PNG
  (assinatura de 8 bytes). `filename`, extensão e `Content-Type` declarado não
  definem o tipo persistido; um header permitido que não bate com o conteúdo
  retorna `422`, e tipo não suportado retorna `415`.
- **Storage:** o objeto vai para o `ObjectStore` privado existente em
  `tenants/<tenant-id>/evidence/<artifact-id>`, sem URL pública/presigned. O
  SHA-256 é calculado dos bytes recebidos e conferido com o retorno do storage.
- **Grafo:** `validation → claim → claim_evidence` (observação) →
  `evidence_artifact` (binário). A claim é criada na mesma transação se a
  validation legada ainda não tiver uma. O vínculo usa a FK composta da F0.1.
- **Semântica:** `source = customer_submitted_document`,
  `checker = customer_document_intake`, `stance = unknown`, `strength = 0`,
  `confidence = 0` e
  `detail.verification = { status: 'pending', method: 'content_intake', document: null, address: null, holder: null }`.
  `confidence` é `NOT NULL`; **0** expressa ausência de avaliação de
  verificação, não negação do documento. A F1.2 extrai campos e a F1.3
  materializa a verificação em **outra linha**; esta linha de intake continua
  `pending` como recibo imutável do upload.
- **Cardinalidade:** no máximo **um** documento do cliente por claim
  (`UNIQUE (claim_id) WHERE source = 'customer_submitted_document'`). Outras
  fontes usam `source` diferente e podem coexistir. Mesmos bytes são replay
  `200`; bytes diferentes retornam `409 EVIDENCE_ALREADY_EXISTS`.
- **Idempotência:** o SHA-256 do conteúdo é a chave natural. O
  `Idempotency-Key` opcional identifica a tentativa do cliente, não a
  identidade permanente da evidência, e é namespaced em
  `validation_idempotency` (`evidence:<validation-id>:<client-key>`) com hash da
  solicitação. Mesma key + mesmo conteúdo = replay `200`; mesma key + conteúdo
  diferente = `422 IDEMPOTENCY_MISMATCH`; key nova + mesmo conteúdo = replay
  (alias), sem nova evidência/artefato; key nova + conteúdo diferente = `409`
  pela cardinalidade.
- **Concorrência:** a transação faz lock da linha da validation; o índice único
  parcial é a segunda barreira. Duas requisições simultâneas produzem uma única
  linha/artefato.
- **Compensação:** o objeto é gravado antes da transação. Falha de
  `claim_evidence`, `evidence_artifact`, marcador de idempotência ou replay
  apaga o objeto recém-gravado. Se o próprio delete falhar, o log registra
  `EVIDENCE_COMPENSATION_FAILED` com ids técnicos e sem filename/conteúdo; não
  há outbox/fila nova.
- **Retenção:** `evidence_artifact.retention_until` e
  `claim_evidence.expires_at` usam `validation.expires_at`; o job de retenção
  existente apaga objeto e grafo. F1.1 não define prazo comercial novo.
- **Resposta:** apenas `evidence_id`, `artifact_id` e `status: "pending"`; nunca
  `storage_key`, URL, filename ou bytes. Replay devolve `200` e o header
  `Idempotent-Replayed: true`; criação devolve `201`.

O `GET /v1/validations/:id` existente reflete as observações em
`evidence_summary` e, desde a F1.3, expõe `evidence_verification` — a
verificação corrente do documento enviado — com as três dimensões, status,
método, fonte, `analysis_id`, analisador/contrato, `observed_at`, limitações e
códigos de comparação. O payload **não** expõe o texto, o nome, o endereço, o
CEP nem o `storage_key` extraídos; esses valores continuam apenas em
`evidence_analysis`/ObjectStore privado. Detalhe completo na seção 5.4.

### 5.3 Análise do documento do cliente (F1.2, implementado)

Contrato e decisão completos no
[ADR-0038](adr/0038-analise-de-documento-do-cliente.md); a escolha da
biblioteca de PDF está no [ADR-0039](adr/0039-extracao-de-pdf-com-unpdf.md).
A cadeia de responsabilidades é:

```text
DocumentAnalyzer
       ↓
extraction / observation   (PDF via unpdf/PDF.js + rótulos explícitos)
       ↓
Verification adapters      (F1.3 upload; F2 fontes fiscais)
       ↓
verification result        (authentic/matches/differs pertencem ao verificador)
```

O analyzer **não** declara autenticidade nem correspondência de endereço/titular.

- **Fluxo:** intake F1.1 grava `evidence_artifact` e enfileira
  `evidence_analysis` (`pending`) na mesma transação. Replay do mesmo conteúdo
  também garante a linha da versão corrente para um artefato já existente. O
  worker consome a fila com `FOR UPDATE SKIP LOCKED`, lê o objeto privado pelo
  `storage_key` opaco, confere tamanho/SHA-256, executa o `DocumentAnalyzer` e
  grava o resultado terminal.
- **Contrato:** `DocumentAnalysisResult` separa `document`, `address` e
  `holder`. Para `document`, a análise produz `analyzed`, `invalid`,
  `inconclusive`, `unsupported` ou `unavailable`; para endereço/titular,
  `extracted`, `not_extracted` ou `unknown`. `authentic`, `matches` e `differs`
  **não existem** neste contrato; pertencem ao verificador.
- **Endereço:** só campos de linhas `Rótulo: valor` explícitas
  (`Endereço`/`Logradouro`, `Número`, `Complemento`, `Bairro`,
  `Cidade`/`Município`, `UF`/`Estado`, `CEP`) são normalizados; a região bruta
  mínima fica em `raw`. Rótulo ausente, ambíguo ou inválido vira
  `null`/`not_extracted`; não há varredura de texto livre.
- **Titular:** nome só quando rotulado. **CPF/CNPJ não são persistidos nesta
  etapa** (minimização de PII); a F1.3 manteve a decisão e compara apenas o nome
  normalizado. A necessidade do identificador fiscal continua aberta para
  F2/F3. Não se infere relação familiar, propriedade ou residência.
- **Tipo e data:** `kind` fica `unknown`; não há lista de concessionárias.
  `issuedAt` é apenas uma observação de `Emissão`/`Competência` com data
  completa, não uma regra de validade.
- **MVP sem provider externo:** o parsing de PDF fica com `unpdf`/PDF.js
  (streams, fontes, encoding, compressão); o Comprova orquestra e aplica
  limites (50 páginas, 1.000.000 caracteres). Imagem retorna
  `unsupported`/`OCR_NOT_IMPLEMENTED`. O protocolo `DocumentAnalyzer` permite
  trocar por OCR/VLM no futuro. A saída é validada por schema e identidade;
  saída inválida vira `failed`, não fica presa em `analyzing`.
- **Idempotência:** chave única
  `(artifact_id, analyzer, analyzer_version, contract_version)`. Replay do
  upload não cria segunda linha; retry não reescreve resultado terminal; uma
  nova versão cria nova linha. Concorrência usa lock de linha + chave única.
- **Erro nunca vira contradição:** `unavailable`, `inconclusive` e `unsupported`
  deixam `address`/`holder` em `unknown` e não geram `stance=contradicts`.
- **PII e retenção:** CPF/CNPJ não entram no `result` desta etapa.
  `evidence_analysis` tem RLS FORCE, FK composta com o artefato e
  `ON DELETE CASCADE`. Logs usam apenas ids/razões técnicas; o `result` não é
  logado. O binário continua no ObjectStore privado, sem URL.
- **Limitação conhecida:** PDFs escaneados ou com fontes sem `ToUnicode` podem
  retornar `inconclusive`/`NO_TEXT_LAYER` ou campos `null`; não há OCR nesta
  etapa. Não há retry automático de resultado terminal; uma nova tentativa exige
  nova versão de analisador/contrato (ou operação explícita).

### 5.4 Verificação do documento enviado (F1.3, implementado)

Contrato puro em `packages/core/src/evidence-verification.ts`; materialização
em `apps/worker/src/modules/evidence-verification/evidence-verification.service.ts`.
A decisão e as alternativas estão no
[ADR-0040](adr/0040-verificacao-do-documento-enviado.md).

- **Entrada:** uma linha **terminal** de `evidence_analysis` da versão corrente
  (`analyzer`, `analyzer_version`, `contract_version`), o `claim`/`validation`,
  o `canonical_address` do alvo e, quando o `subject` é CNPJ com
  `deep_context.record`, a razão social (`ref_receita_empresa`) e o nome
  fantasia. A verificação não lê bytes nem chama provider externo.
- **Saída:** uma linha em `claim_evidence` com
  `source = 'uploaded_document'`, `checker = 'document_upload_verification'`,
  `stance` da política, `strength = 0`, `confidence = 0`,
  `evidence_sha256` do artefato e `detail.verification` contendo `status`,
  `method = 'content_extraction'`, `source`, `document`, `address`, `holder`,
  `analysis_id`, `artifact_id`, `analyzer`, `contract_version`, `observed_at`,
  `limitations`, `error_codes` e `comparison.{address,holder}`.
- **Três dimensões independentes:** `document` é `inconclusive` quando a
  extração termina porque o upload não tem consulta oficial nem assinatura;
  `invalid`, `unsupported` e `unavailable` são preservados. `address` e
  `holder` são `matches`, `differs` ou `not_extracted`.
- **Stance e score:** a política da F1.3 mantém `stance = 'unknown'` para o
  upload e **não insere `signal`**. `weightedScore`, `score`, `confidence` e
  veredito da validation não mudam. A F3 pode decidir se um match de conteúdo
  passa a `supports`; a F2 traz `authentic` de fonte oficial. A regra dura
  permanece: `unavailable`, `inconclusive` e `unsupported` nunca viram
  `contradicts`.
- **Endereço:** CEP, UF, logradouro e número são campos fortes; bairro, cidade e
  complemento são de apoio e não produzem `differs` sozinhos. A comparação é
  igualdade exata após `normalizeCep`, `normalizeUf`, `normalizeLogradouro`,
  `normalizeNumero` e `normalizeText` — nunca `includes`/substring. Sem campo
  forte comparável, o resultado é `not_extracted`; sem `canonical_address`,
  também.
- **Titular:** igualdade exata após normalização e remoção de sufixos
  societários (`LTDA`, `ME`, `EPP`, `EIRELI`, `S/A`, `SA`, `SOCIEDADE
ANONIMA`, `MICROEMPRESA`, `EMPRESARIO INDIVIDUAL`). Sem nome extraído ou sem
  referência, `not_extracted`. Com razão social de referência, um nome diferente
  produz `differs`; com **apenas** nome fantasia, um nome diferente produz
  `not_extracted` (`HOLDER_REFERENCE_WEAK`), pois o nome extraído pode ser a
  razão social ausente. Não há similaridade difusa, iniciais nem inferência de
  sócio.
- **Idempotência e versão:** índice único parcial
  `(claim_id, checker, checker_version) WHERE source = 'uploaded_document'`,
  com `checker_version = política + analyzer_version + contract_version`.
  Replay/retry da mesma versão não duplica; nova versão de política, analisador
  ou contrato cria outra linha e preserva a anterior. A leitura corrente no
  `GET` é a linha de `uploaded_document` com `observed_at` mais recente
  (desempate `created_at`); as anteriores ficam para auditoria.
- **Imutabilidade:** a linha F1.1 (`customer_submitted_document`) continua
  intocada como recibo do intake. A linha F1.3 é uma observação separada;
  `claim_evidence` segue append-only e a única transição permitida continua
  sendo `evidence_id X → NULL` na retenção.
- **Tenant e PII:** a fila atravessa tenants com o pool de manutenção, mas toda
  leitura/escrita do claim usa `withTenant`; o candidato exige igualdade de
  tenant entre análise, artefato, intake e claim. Logs usam apenas ids, status e
  reason codes. O `detail` não copia nome, endereço, CEP nem CPF/CNPJ; os campos
  extraídos continuam em `evidence_analysis`, que é apagada em cascata com o
  artefato.
- **Falha e retry:** `skipped` (claim/validation ausente) ou erro de
  materialização não cria evidência e não interrompe o tick; o candidato é
  excluído do restante do tick e recebe backoff exponencial persistente
  (60 s → 1 h) em `evidence_verification_attempt`, por `analysis_id` e tenant.
  Sucesso remove a tentativa. Assim um candidato sem contexto não bloqueia
  candidatos de outros tenants; a tabela não contém PII e é admin-only.
- **Contrato público:** `GET /v1/validations/:id` expõe
  `evidence_verification` (objeto ou `null`) com as três dimensões, status,
  método, fonte, `analysis_id`, analisador/contrato, `observed_at`, limitações,
  erros e códigos de comparação. Não expõe valores extraídos nem `storage_key`.
- **Teste:** `apps/api/tests/evidence-verification.int.test.ts` cobre
  endereço/titular extraídos, `matches`/`differs`/`not_extracted`, PDF sem
  camada textual, documento inválido, reprocessamento, nova versão,
  cross-tenant/RLS, logs sem PII e skip/backoff sem bloquear outro tenant.

### 5.5 Contrato fiscal e materialização (F2.1, implementado)

A F2.1 define o contrato e a materialização da primeira fonte externa; a
consulta real pertence à F2.2b. Contrato puro em
`packages/core/src/fiscal-verification.ts`; materialização em
`apps/worker/src/modules/fiscal-verification/fiscal-verification.service.ts`;
adapter determinístico em `packages/providers/src/fiscal/`. Decisão em
[ADR-0041](adr/0041-contrato-fiscal-adapter.md).

- **Adapter:** `FiscalAdapter` tem `source`, `version`, `supports(input)` e
  `verify(input, context)`. A entrada (`FiscalLookupInput`) carrega `source`
  (`nf3e` ou `nfag-e`), `tenantId`, `claimId`, `documentId`, `qrCodeUrl`,
  `issuer`, `uf` e referência de artefato. **Não há endpoint, credencial HTTP,
  cookie ou função de fetch no contrato.** O contexto (`FiscalAdapterContext`)
  leva o tenant, o endereço/titular de comparação e um `now()` injetado.
- **Resultado:** `FiscalVerificationResult` separa `document`, `address` e
  `holder`, além de `method`, `environment`, `issuer`, `documentId`, `issuedAt`,
  `observedAt`, `limitations`, `errorCodes`, `artifact` e `audit`. A taxonomia é
  a existente (ADR-0033): `authentic` é o estado **verified** da fonte oficial,
  e não criamos um vocabulário paralelo. Não existem `trust_score`,
  `final_score`, `approved` ou `rejected`; a validação por schema remove
  qualquer campo extra emitido por um adapter.
- **Sem scoring:** a materialização grava **uma** linha em `claim_evidence`
  (`source = 'fiscal_nf3e'`/`'fiscal_nfag'`,
  `checker = 'nf3e_verification'`/`'nfag-e_verification'`) com as três dimensões
  em `detail.verification`. `stance` usa a política compartilhada
  `stanceForDimensions`; `strength = 0`, `confidence = 0` e **nenhum `signal`**
  é inserido. Portanto o `weightedScore` e o veredito não mudam nesta etapa.
  `unavailable`, `inconclusive` e `unsupported` permanecem `unknown`; timeout da
  fonte vira `unavailable`, nunca `invalid`.
- **Idempotência e versão:** a chave natural é
  `(claim_id, source, checker, checker_version)`. `checker_version` combina a
  versão do adapter, o adapter de origem, um hash estável da referência do
  documento (`document_ref_hash`) e a versão do contrato fiscal. Resultados
  transitórios (`unavailable`, `inconclusive`, `unsupported`) recebem um
  discriminador `+o<outcome>`, então uma tentativa posterior terminal
  (`authentic`/`not_found`/`invalid`) não é descartada como duplicata. A mesma
  consulta não duplica; dois documentos diferentes no mesmo claim não colidem;
  uma nova versão do adapter cria outra linha e preserva a anterior.
- **Integridade do resultado:** um resultado de adapter cujo `documentId` não
  nulo diverge do `documentId` do input vira `unavailable` com
  `ADAPTER_RESULT_DOCUMENT_MISMATCH`; ele nunca é materializado como `authentic`.
  `limitations`/`errorCodes` passam por uma allowlist finita
  (`FISCAL_REASON_CODES`); valores desconhecidos viram `ADAPTER_ERROR` antes de
  qualquer persistência ou log.
- **Tenant e RLS:** a leitura do claim/validation/endereço/titular e a escrita
  da observação usam `withTenant`. Um input de tenant A apontando para claim de
  tenant B retorna `skipped` e não materializa nada.
- **Minimização:** a resposta externa bruta não é persistida. O `detail` guarda
  outcomes, `document_ref_hash`, versão, limitações, códigos, `uf`,
  `qr_present`, IP resolvido, status HTTP, hash do corpo e hash da URL pedida.
  A chave de acesso/URL do QR não é copiada; logs usam apenas ids, status e
  reason codes.
- **SSRF:** a URL do QR nunca é buscada. `packages/providers/src/fiscal/endpoint.ts`
  define a allowlist server-side por `(source, issuer, environment)`, com a
  entrada SVRS em produção para NF3-e, e delega a chamada para a guarda única
  `safeExternalFetch`
  (ADR-0036). Um endpoint fora da allowlist nem chega ao fetch; mesmo uma
  allowlist mal configurada para metadata/RFC1918 é barrada pela guarda.
- **Entregue na F2.2b:** decodificação física do QR, seleção do autorizador
  SVRS, consulta HTTP pela allowlist em produção para RS/SP, normalização da
  resposta e exposição do detalhe fiscal no `GET`.
- **Ainda pendente:** certificado/SOAP, cache, rate limit por fonte, métricas,
  expansão de autorizadores/UFs e NFAg-e.

Testes: `packages/core/src/fiscal-verification.test.ts` (taxonomia, fingerprint,
versão, stance), `packages/providers/src/fiscal/fiscal.test.ts` (fake adapter,
schema, allowlist e SSRF) e
`apps/api/tests/fiscal-verification.int.test.ts` (todos os status, dimensões,
idempotência, versionamento, cross-tenant, ausência de `signal` e de PII/bruto).

### 5.6 Referência fiscal/QR: extração e normalização (F2.2a/F2.2b — parte física, implementado)

A F2.2a é a ponte entre o documento/artefato e o `FiscalAdapter`, sem executar
rede. Ela recebe uma referência **já extraída** — payload de
QR, URL, chave de acesso ou texto — e devolve um `FiscalReference` normalizado.
A parte física da F2.2b decodifica o QR do próprio artefato (PNG/JPEG e raster
embutido em PDF) e entrega o payload ao mesmo normalizador; **não há fetch**.
Contrato puro em `packages/core/src/fiscal-reference.ts`; extractor em
`packages/providers/src/fiscal/reference.ts`. Detalhes da parte física e das
dependências em [`architecture.md`](architecture.md).

- **Contrato:** `FiscalReference` carrega `status`, `source`, `issuer`, `uf`,
  `url`, `documentId`, `method`, `limitations`, `errorCodes` e `fingerprint`.
  Não há score, confiança, aprovação, autenticidade nem decisão KYC. `status`
  distingue `found` / `not_found` / `inconclusive` / `unsupported`; ausência de
  QR vira `not_found` e nunca invalida o documento. `inconclusive` cobre QR
  ilegível, decoder indisponível e PDF não inspecionável; `unsupported` fica
  para conteúdo reconhecido mas fora do suporte.
- **Contexto confiável:** `toFiscalLookupInput(reference, context)` recebe
  `tenantId`, `claimId` e `artifact` do pipeline. Só produz
  `FiscalLookupInput` quando `status = found` e há fonte; a referência não pode
  alterar tenant, claim ou artefato.
- **Reconhecimento NF3e:** por padrão estrutural. Autorizador conhecido só
  identifica a fonte com o caminho esperado do endpoint de QR (`SVRS`, `SC`,
  `MG`, `MT`); host ou caminho desconhecido não vira autorizador. Uma chave de
  44 dígitos estritamente numérica, com UF IBGE válida, modelo `66` e DV módulo
  11, identifica NF3e mesmo sem autorizador (`issuer = null`,
  `UNKNOWN_ISSUER`). Parâmetros de chave duplicados/conflitantes retornam
  `AMBIGUOUS_REFERENCE`; valor não estrito retorna `INVALID_DOCUMENT_ID`.
  NFAg-e permanece `unsupported` (`SOURCE_NOT_SUPPORTED`).
- **Camada textual primeiro:** o analyzer (F1.2) aplica
  `extractFiscalReferenceFromText` ao texto que o PDF.js já extrai para os
  campos. URL de autorizador conhecido + chave válida dispensa o QR; chave
  isolada (`UNKNOWN_ISSUER`) ou URL sem chave ainda dependem do QR, que é o
  artefato canônico do emitente. Evidências compatíveis de texto e QR se
  completam (a chave impressa preenche a URL sem documento e o QR fornece o
  autorizador que falta), mas duas chaves divergentes não são combinadas e
  resultam em `AMBIGUOUS_REFERENCE`. URLs não fiscais no texto (site do
  emitente, política de privacidade) não competem com a URL de consulta nem
  escondem a chave impressa. Nenhum caminho chama VLM/LLM nem busca a URL.
- **Limitações x erros:** `limitations` registra condições informativas de uma
  referência `found` (`UNKNOWN_ISSUER`, `DOCUMENT_ID_MISSING`); `errorCodes`
  fica vazio em `found` e só recebe códigos em `unsupported`.
- **URL não confiável:** o extractor **não faz fetch, HEAD, DNS lookup nem
  segue redirect**. Reutiliza `isSafeExternalUrl` (F0.2) para rejeitar URLs
  arbitrárias inseguras; o QR HTTP legado da EDP só é aceito para o host/caminho
  SVRS conhecido e uma chave NF3-e válida, sendo normalizado para HTTPS. A URL
  continua apenas uma referência; a consulta usa a allowlist server-side.
- **Decodificação local:** `zxing-wasm` carrega o WASM apenas do pacote
  instalado (`wasmBinary`), sem CDN/fetch/DNS/redirect; `image-size` faz a
  pré-checagem de dimensões. Tetos: 16 MP e 10.000 px por imagem, 8 símbolos
  (mínimo 2), 50 páginas e 64 imagens por PDF. Estouro vira `inconclusive`.
- **PDF sem canvas:** só raster embutido via `unpdf.extractImages`; QR
  vetorial/desenhado retorna `PDF_QR_VECTOR_UNSUPPORTED`. PDF com raster
  inspecionado sem QR também é `inconclusive`, pois não é possível afirmar
  ausência absoluta; `not_found` fica para artefatos integralmente
  inspecionáveis (PNG/JPEG). O limite de páginas é validado antes de decodificar
  QR ou texto.
- **Múltiplos QR:** mesmo fingerprint → `found`; referências fiscais distintas →
  `unsupported`/`AMBIGUOUS_REFERENCE`; fiscal + não fiscal → `found` com
  `MULTIPLE_QR_CODES`. Nunca escolhe o primeiro QR. O decoder lê
  `maxSymbols + 1` apenas para detectar truncamento; exatamente `maxSymbols`
  referências legíveis ainda passam pela política.
- **Persistência:** `DocumentAnalysisResult` (contrato `3`,
  `text_document@1.2.0`) carrega `fiscalReference`; a URL é removida antes de
  gravar em `evidence_analysis.result`, preservando `fingerprint` e
  `documentId`.
- **Minimização e determinismo:** a referência não persiste PII nem texto bruto;
  o `fingerprint` SHA-256 truncado é calculado apenas sobre campos normalizados.
  Ele inclui a URL normalizada e é preservado na redaction, portanto não é
  recalculável a partir da projeção persistida (`url = null`); `documentId` é o
  identificador fiscal estável e a URL é dado transitório. A idempotência final
  continua em `(claim_id, source, checker, checker_version)` (F2.1).

Testes: `packages/core/src/fiscal-reference.test.ts` (conversão para input,
contexto confiável, fingerprint), `packages/providers/src/fiscal/reference.test.ts`
(reconhecimento, URLs maliciosas, ambiguidade, chave inválida, ausência de PII),
`packages/providers/src/fiscal/reference-artifact.test.ts` (PNG/JPEG/PDF,
limites, múltiplos QR inclusive com `maxSymbols = 2`),
`reference-artifact.network.test.ts` (matriz
loopback/localhost/metadata/RFC1918 com `fetch` envenenado),
`reference-artifact.retry.test.ts` (retry após falha de inicialização do WASM),
`packages/providers/src/document-analyzer/analyze.pdf-limits.test.ts` (limite de
páginas antes da decodificação e PDF raster sem QR → `inconclusive`) e
`apps/api/tests/fiscal-verification.int.test.ts` +
`apps/api/tests/evidence-analysis.int.test.ts` (referência extraída →
`FiscalLookupInput` → `FakeFiscalAdapter` → `claim_evidence`, URL não
persistida, idempotência/replay e cross-tenant, sem rede).

## 6. Segurança das consultas externas

A guarda genérica `safeExternalFetch` foi entregue em F0.2 (ADR-0036) e já é
usada no envio de webhook e na consulta fiscal. Ela cobre resolução/fixação de
IP, HTTPS, ausência de redirect e limites de tempo/corpo/content-type. A F2.1
entregou o contrato do adaptador e o esqueleto da allowlist; a F2.2a entrega a
referência normalizada (sem rede), e a F2.2b entrega a decodificação local do
QR e a primeira consulta NF3-e real via SVRS em produção para RS/SP
(ADR-0034, ADR-0041).
Requisitos:

1. **Allowlist server-side** por `(tipo de documento, autorizador, ambiente)`.
   A URL do QR é usada apenas para **identificar** o autorizador — nunca para
   fetch. **Esqueleto implementado em F2.1**
   (`packages/providers/src/fiscal/endpoint.ts`), com a primeira entrada real
   para `nf3e/SVRS/production`; novas entradas entram conforme a cobertura for
   priorizada.
2. **Resolução e fixação de IP:** resolver o host, rejeitar loopback, RFC1918,
   link-local (`169.254.0.0/16`), metadata (`169.254.169.254`), IPv6
   `::1`/`fc00::/7`/`fe80::/10`, e conectar ao IP validado (evita DNS
   rebinding). **Implementado em `safeExternalFetch` (F0.2).**
3. **Sem redirect:** 3xx é erro de fonte, não segue. **Implementado (F0.2).**
4. **Limites:** timeout, corpo e content-type. **Implementado (F0.2);** a
   allowlist de MIME por fonte fiscal deve ser escolhida no adaptador (ex.:
   `text/html`, `application/xml`, `application/json`).
5. **Sem credenciais/cookies** e sem executar JavaScript. A guarda rejeita
   credenciais embutidas na URL (F0.2); cookies e headers de sessão são proibidos
   por política do caller fiscal. O contrato F2.1 não expõe cookies nem
   credenciais; o adapter concreto (F2.2) deve continuar sem eles.
6. **Auditoria:** gravar IP resolvido (`SafeFetchResponse.address`), status HTTP
   e sha256 da resposta, não a resposta inteira em log. **O IP/status são
   expostos pela guarda;** a F2.1 persiste IP, status, hash do corpo e hash da
   URL pedida, nunca a URL crua.
7. **Rate limit** por tenant e por fonte, além do cache por chave. **Ainda não
   implementado; permanece backlog operacional da F2.2/F6.**

`isSafeWebhookUrl` continua apenas no cadastro como validação de UX; ela não
resolve DNS e não substitui a guarda no envio.

Testes obrigatórios já cobertos para a guarda: host privado literal, host que
resolve para privado, redirect para privado/HTTP/outro host, corpo grande,
content-type inesperado, timeout e rebinding. Em F2.1,
`packages/providers/src/fiscal/fiscal.test.ts` cobre endpoint fora da allowlist
(sem chamar o fetch), URL de QR hostil que nunca é usada e allowlist mal
configurada para metadata/RFC1918 barrada pela guarda. A consulta real continua
fora de escopo.

## 7. Confiança, atualidade e divergência

| Dimensão               | Campo hoje                                                                                 | Semântica                             |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| Quando foi observado   | `claim_evidence.observed_at`                                                               | Momento da coleta (consulta/extração) |
| Validade da evidência  | `claim_evidence.ttl_seconds` + `decayOf`                                                   | Quanto o sinal decai no score         |
| Validade do artefato   | `evidence_artifact.retention_until` (cliente) / `evidence.retention_until` (legado)        | Quanto o binário é retido (LGPD)      |
| Emissão do documento   | `evidence_analysis.result.document.issuedAt` (extração) / `detail.issued_at` (verificação) | Competência do comprovante            |
| Retenção da validação  | `validation.expires_at`                                                                    | 30 dias hoje, hardcoded               |
| Validade da credencial | `validFrom` / `validUntil`                                                                 | Derivada do completion + TTL          |

Regras:

- **Documento antigo não é documento inválido.** Uma conta de luz de 2023 pode
  ser autêntica e ainda assim não servir como comprovante atual. O resultado
  carrega `issuedAt` e a política decide; não se inventa "contradicts" por
  idade.
- **Decaimento já existe** (`decayOf`): não criar segundo mecanismo.
- **Divergência é resultado, não erro.** Se a nova evidência contradiz a antiga,
  o produto devolve `diverged` com as duas explicações; não sobrescreve.

### 7.1 Duplicidade e independência no score

`weightedScore` (`packages/core/src/scoring.ts`) soma
`stance × strength × confidence × decay × weight` **sem deduplicar por fonte**.
Adicionar NF3e como mais um `supports` pode contar duas vezes o mesmo fato
(registro + conta de luz dizem a mesma coisa sobre o mesmo endereço). Opções:

1. **Agora:** o adaptador usa peso baixo e o `required_checkers`/hard rules da
   policy tratam a fonte fiscal como confirmação qualitativa.
2. **Depois (SCORER_VERSION=2):** agrupar sinais por `source_group` e impedir
   que dois sinais do mesmo grupo somem como independentes.

Recomendação: **1 agora, 2 quando houver a segunda fonte fiscal**. Não bumpar o
scorer sem necessidade.

## 8. Histórico e supersessão

O que já existe:

- `validation` é imutável e particionada por mês; cada pedido é uma linha nova.
- `credential_issuance` é append-only e a credencial superada é marcada no deep
  path (ADR-0024, C1).
- `validation.expires_at` remove o grafo na retenção.

O que falta para o fluxo do banco (F4):

- saber **qual** validação substitui **qual**;
- comparar resultados de forma explícita;
- impedir que a "atualização" seja lida como "a anterior estava errada".

Extensão mínima proposta (não implementar agora):

```text
validation.supersedes_validation_id uuid NULL
  → FK para validation(validation_id), imutável
```

Com isso, `supersedes` é um fato auditável e o "resultado atual" é uma consulta
(maior `created_at` da cadeia), sem coluna mutável de "current". Alternativa
mais pesada: entidade `verification_case`. Recomendação: só a coluna, e só
quando F4 começar.

Regra de ouro: **nenhuma credencial assinada é alterada**. Se a evidência mudou,
emite-se nova credencial e a antiga é revogada/superada conforme o fluxo atual.

## 9. Fontes fiscais: o que está confirmado

### NF3e (modelo 66)

| Item                       | Fato (2026-10-22)                                       |
| -------------------------- | ------------------------------------------------------- |
| Norma                      | Ajuste SINIEF 01/19; obrigatória                        |
| SP                         | Exigida desde 01/10/2025 (Portaria SRE 42/2025)         |
| Autorizadores em produção  | MG, MS, MT, PR, SVRS, SC                                |
| Consulta                   | QR Code público por autorizador; URL varia              |
| O que a autorização valida | Forma, assinatura e layout — **não o mérito dos dados** |

Endpoints de QR observados (usar como **fonte de allowlist**, sujeitos a
confirmação e versionamento):

| Autorizador | URL de consulta observada                                              |
| ----------- | ---------------------------------------------------------------------- |
| SVRS        | `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode`                        |
| SC          | `https://sat.sef.sc.gov.br/nf3e/consulta`                              |
| MG          | `https://portalsped.fazenda.mg.gov.br/portalnf3e/sistema/qrcode.xhtml` |
| MT          | `https://www.sefaz.mt.gov.br/nf3e/QRCode`                              |
| PR          | Não listado na página consultada                                       |
| MS          | A página aponta um WSDL — **não usar**; confirmar                      |

Não confirmado: autorizador efetivo de SP, exigência de certificado na consulta
pública, termos de uso de consulta automatizada.

### NFAg-e (modelo 75)

| Item             | Fato (2026-10-22)                                                             |
| ---------------- | ----------------------------------------------------------------------------- |
| Status           | Publicada como **Minuta**, aguardando ato conjunto definitivo                 |
| Autorizador      | Somente SVRS (produção e homologação)                                         |
| Implantação      | NT 2026.004 em homologação (19/10/2026); NT 2026.002 em produção (31/08/2026) |
| QR               | `https://dfe-portal.svrs.rs.gov.br/nfag/qrCode`                               |
| Consulta pública | `/NFAG/Consulta`                                                              |

Consequência: **não prometer cobertura nacional** e não iniciar F7 antes do ato
definitivo + demanda.

## 10. Extensões mínimas recomendadas

| Necessidade                 | Mudança mínima                                          | Quando                        |
| --------------------------- | ------------------------------------------------------- | ----------------------------- |
| Escopo tenant de PII        | `evidence_artifact` (entregue em F0.1)                  | F0.1                          |
| Guarda de fetch             | Módulo único testado, reusado por webhook e fiscal      | F0                            |
| Contrato de verificador     | Módulo puro + tipos + testes                            | F1.3 (upload) / F2.1 (fiscal) |
| Observação fiscal           | Linha em `claim_evidence` sem `signal` + índice parcial | F2.1 (entregue)               |
| Allowlist de autorizadores  | Tabela versionada em código                             | F2.1 (esqueleto vazio) / F2.2 |
| Evento faturável            | `usage_event` com unique/idempotência                   | F3                            |
| Supersessão                 | `validation.supersedes_validation_id`                   | F4                            |
| Status padrão de credencial | Decisão; sem migração até decidir                       | F5                            |
| Policy por cliente          | Decisão; sem schema até decidir                         | F3/F5                         |

Nenhuma dessas mudanças é pré-requisito para as outras fases além do indicado.
**Não implementar todas de uma vez.**

## 11. Decisões abertas

1. ~~`evidence` com `tenant_id` ou `evidence_artifact` separado?~~ **Decidido:
   `evidence_artifact` tenant-scoped (ADR-0035).**
2. ~~Reter binário ou hash + campos?~~ **Decidido na fundação: objeto no storage
   privado + metadados; prazo comercial de retenção permanece aberto.**
3. ~~Uma observação por fonte ou por dimensão?~~ **Decidido na F1.3: uma linha
   por fonte/versão de verificação, com as três dimensões no `detail`; o
   upload não emite `signal` (ADR-0040). A F2.1 aplica a mesma regra à fonte
   fiscal, incluindo o hash do documento na versão do checker (ADR-0041).**
4. NF3e por QR público ou SOAP com certificado? **O contrato F2.1 aceita ambos
   (`method`); a escolha real e o parsing ficam para F2.2.**
5. UFs iniciais? (F2.2)
6. Credencial: recibo B2B ou credencial do titular? (F5)
7. Policy por cliente é requisito do primeiro contrato? (F3/F5)
8. Como o titular se autentica no link? (F4)

## 12. Referências

- [Arquitetura atual](architecture.md)
- [Roadmap](roadmap.md)
- [ADR-0016 — Claim/evidence](adr/0016-claim-evidence-assessment.md)
- [ADR-0024 — Conformidade W3C](adr/0024-conformidade-w3c-identificadores-e-tempos.md)
- [ADR-0033 — Verificação por adaptadores](adr/0033-verificacao-de-evidencias-por-adaptadores.md)
- [ADR-0034 — Consulta a endpoints oficiais](adr/0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
- [ADR-0035 — Artefato de evidência tenant-scoped](adr/0035-artefato-de-evidencia-tenant-scoped.md)
- [ADR-0036 — Guarda de fetch externo](adr/0036-guarda-de-fetch-externo.md)
- [ADR-0040 — Verificação do documento enviado](adr/0040-verificacao-do-documento-enviado.md)
- [ADR-0041 — Contrato FiscalAdapter e materialização fiscal](adr/0041-contrato-fiscal-adapter.md)
- [NF3e — FAQ SVRS](https://dfe-portal.svrs.rs.gov.br/Nf3e/Faq)
- [NF3e — Serviços SVRS](https://dfe-portal.svrs.rs.gov.br/Nf3e/Servicos)
- [NFAg — portal SVRS](https://dfe-portal.svrs.rs.gov.br/Nfag)
- [NFAg — Serviços SVRS](https://dfe-portal.svrs.rs.gov.br/Nfag/Servicos)
