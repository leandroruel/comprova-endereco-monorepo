# ADR-0038: Análise do documento do cliente (F1.2)

## Status

Aceito (2026-10-22). Emendado em 2026-10-23 pelo
[ADR-0039](0039-extracao-de-pdf-com-unpdf.md): o parser PDF artesanal foi
removido, a extração de texto passou a usar `unpdf`/PDF.js, o contrato subiu
para a versão `2` e CPF/CNPJ deixaram de ser persistidos nesta etapa.
Implementa a etapa de **análise** entre o intake F1.1 e a verificação F1.3/F2.
Não implementa matching, autenticidade, consulta fiscal, billing, wallet nem
autenticação do titular.

Relaciona-se com o [ADR-0016](0016-claim-evidence-assessment.md) (observação e
avaliação), [ADR-0033](0033-verificacao-de-evidencias-por-adaptadores.md)
(contrato do verificador), [ADR-0035](0035-artefato-de-evidencia-tenant-scoped.md)
(artefato de PII), [ADR-0037](0037-intake-de-comprovante-do-cliente.md)
(intake F1.1) e [ADR-0039](0039-extracao-de-pdf-com-unpdf.md) (parsing de PDF).

## Contexto

A F1.1 grava, na mesma transação:

```text
validation → claim → claim_evidence (unknown/pending) → evidence_artifact
```

Duas restrições existentes impedem persistir o resultado da análise nesses
lugares:

1. `claim_evidence` é **imutável** por trigger (`claim_evidence_guard_trg`) e
   tem no máximo um documento do cliente por claim (índice parcial da 0040).
   O `detail.verification.status` fica `pending` e não pode ser preenchido
   depois.
2. `evidence_artifact` é **write-once** e guarda o binário/metadados, não o
   resultado de extração.

O ADR-0033 já separa três dimensões independentes — `document`, `address` e
`holder` — e proíbe colapsá-las em um booleano. Ele também antecipa que
`unavailable`, `inconclusive` e `unsupported` nunca podem virar
`contradicts`. Faltava decidir **onde** persistir a observação intermediária
sem reescrever o intake e sem criar uma entidade de documento paralela.

## Decisão

### 1. Duas etapas, dois contratos

A análise F1.2 é uma etapa própria:

```text
upload (F1.1) → análise (F1.2) → verificação/matching (F1.3/F2)
```

- **Upload ≠ análise ≠ verificação.** O upload só recebe e guarda. A análise
  extrai e normaliza. A verificação decide autenticidade, correspondência de
  endereço e vínculo com o titular.
- O contrato da análise **não** reutiliza `authentic`, `not_found`,
  `matches` ou `differs`. Esses valores pertencem ao verificador.
- A taxonomia da análise é:

```ts
document: 'analyzed' | 'invalid' | 'inconclusive' | 'unsupported' | 'unavailable'
address: 'extracted' | 'not_extracted' | 'unknown'
holder: 'extracted' | 'not_extracted' | 'unknown'
analysis: 'completed' | 'inconclusive' | 'unsupported' | 'unavailable' | 'failed'
```

`matches`/`differs` serão produzidos somente quando houver comparação com o
`claim`; `extracted`/`not_extracted` são fatos da extração. O mapeamento futuro
para o verificador é:

```text
address=extracted + comparação posterior → matches | differs
address=not_extracted                    → not_extracted
address=unknown, inconclusive, unavailable, unsupported → unknown
```

### 2. Persistência mínima: `evidence_analysis`

Criar uma tabela append-only, tenant-scoped:

```text
evidence_analysis (
  analysis_id, tenant_id, artifact_id,
  analyzer, analyzer_version, contract_version,
  status, result jsonb, error_codes,
  attempts, last_error, created_at, updated_at, analyzed_at
)
```

Chave única:

```text
(artifact_id, analyzer, analyzer_version, contract_version)
```

Ela é a menor extensão compatível com o modelo atual:

- Não cria `uploaded_document`, `address_document`, `proof_of_address` nem
  entidade de documento paralela.
- Não altera `claim_evidence` nem `evidence_artifact`.
- Uma nova versão do analisador ou do contrato cria uma nova linha e preserva
  a anterior; a versão antiga não é sobrescrita.
- O resultado terminal (`result` não nulo) é imutável por trigger. Uma linha
  `pending`/`analyzing` pode transicionar; uma linha terminal não.
- A FK composta `(artifact_id, tenant_id)` impede apontar para artefato de
  outro tenant; `ON DELETE CASCADE` faz a retenção apagar a análise (que pode
  conter PII) junto do artefato.

O `claim_evidence` da F1.1 continua `unknown`/`pending`. A F1.3/F2 consumirá
`evidence_analysis` e decidirá como materializar a verificação em
`claim_evidence`; essa decisão **não** é tomada aqui.

### 3. Fluxo e idempotência

1. O intake insere `evidence_analysis` com `status='pending'` na mesma
   transação do artefato. Replay do upload também garante a linha `pending` da
   versão corrente (inclusive para artefato já existente), usando
   `ON CONFLICT DO NOTHING` pela chave única.
2. O worker consome linhas `pending` (ou `analyzing` órfãs após timeout) com
   `FOR UPDATE SKIP LOCKED`, marca `analyzing` e incrementa `attempts`.
3. Carrega o artefato **pelo `storage_key` opaco**, nunca por URL, com
   `withTenant`; confere tamanho e SHA-256 antes de analisar.
4. Persiste o resultado terminal uma única vez com `status = result.status`.
   Execuções posteriores não reclamam a linha terminal.
5. Execução concorrente: a linha travada é pulada pelo segundo worker; a chave
   única é a segunda barreira. Retry/replay não cria uma segunda análise.

Não há Redis, fila nova ou endpoint `/analyze`. O loop existente do worker usa o
Postgres e o pool de manutenção (admin) apenas para atravessar tenants; o acesso
ao artefato continua com `withTenant`. Sem `DATABASE_ADMIN_URL`, o loop não sobe
e o worker registra um aviso — a RLS não é contornada silenciosamente.

### 4. Analisador MVP

`DocumentAnalyzer` é um protocolo com `id`, `version`, `contractVersion` e
`analyze({ data, contentType })`. O MVP:

- PDF: usa `unpdf` (que empacota o PDF.js) para parsing de objetos, streams,
  compressão, fontes, encoding e camada textual. O Comprova não mantém parser
  PDF próprio; apenas orquestra a biblioteca e aplica limites (50 páginas,
  1.000.000 caracteres, bytes do intake). PDF criptografado é `unsupported`;
  PDF inválido é `invalid`; falha de extração/texto ausente é `inconclusive`.
- Imagem JPEG/PNG: retorna `unsupported`/`OCR_NOT_IMPLEMENTED`. OCR/VLM fica
  para uma implementação futura do mesmo protocolo; nenhum PII é enviado para
  fora nesta etapa.
- Endereço: só extrai campos de linhas `Rótulo: valor` explícitas
  (`Endereço`/`Logradouro`, `Número`, `Complemento`, `Bairro`,
  `Cidade`/`Município`, `UF`/`Estado`, `CEP`), normaliza e preserva um `raw`
  mínimo. Rótulo ausente, repetido com valores diferentes ou inválido vira
  `null`/`not_extracted`; não há varredura de texto livre nem inferência de CEP.
- Titular: extrai apenas o nome quando rotulado (`Titular`, `Nome do titular`,
  `Nome`, `Cliente`, `Razão social`). **CPF/CNPJ não são persistidos** nesta
  etapa: o identificador fiscal é PII e sua necessidade pertence à verificação
  F1.3/F2. Um identificador na mesma linha do nome é descartado. Não se infere
  relação familiar, propriedade nem residência.
- Tipo de documento: `kind` fica `unknown`. Não há lista de CEMIG/ENEL/CPFL/
  SABESP/Vivo/Claro/TIM; uma classificação confiável pertence a um adaptador de
  fonte fiscal futuro.
- Data: `issuedAt` é apenas uma observação extraída dos rótulos `Emissão`,
  `Data de emissão` ou `Competência`, aceitando somente data completa. Não
  define validade nem expiração do documento.
- Documento sem endereço/titular retorna `not_extracted`, não falha.

### 5. Semântica de erro

| Situação                        | `analysis.status` | `document.status` | `address`/`holder`          |
| ------------------------------- | ----------------- | ----------------- | --------------------------- |
| PDF textual analisado           | `completed`       | `analyzed`        | `extracted`/`not_extracted` |
| PDF estruturalmente inválido    | `inconclusive`    | `invalid`         | `unknown`                   |
| PDF sem camada textual          | `inconclusive`    | `inconclusive`    | `unknown`                   |
| PDF criptografado               | `unsupported`     | `unsupported`     | `unknown`                   |
| PDF acima de 50 páginas         | `inconclusive`    | `inconclusive`    | `unknown`                   |
| Texto acima de 1.000.000 chars  | `inconclusive`    | `inconclusive`    | `unknown`                   |
| Falha de extração de texto      | `inconclusive`    | `inconclusive`    | `unknown`                   |
| Imagem/tipo não suportado       | `unsupported`     | `unsupported`     | `unknown`                   |
| Storage/analisador indisponível | `unavailable`     | `unavailable`     | `unknown`                   |
| Erro interno inesperado         | `failed`          | `inconclusive`    | `unknown`                   |

`unavailable`, `inconclusive` e `unsupported` **nunca** produzem
`address=differs` nem `stance=contradicts`. O teste cobre isso no intake e na
persistência.

## Segurança e LGPD

- Storage privado, chave opaca; nenhum URL/presigned no resultado, no banco ou
  nos logs.
- `evidence_analysis` tem RLS FORCE por tenant, FK composta com
  `evidence_artifact` e retenção em cascata.
- `result` e `last_error` não são logados. Os logs usam apenas `analysis_id`,
  `artifact_id`, `tenant_id`, status/razão técnica e nome da classe de erro.
- **CPF/CNPJ não são persistidos no F1.2.** O analyzer só extrai o nome do
  titular; um identificador fiscal na mesma linha é descartado. A decisão de
  guardar ou comparar o identificador fica para a verificação F1.3/F2. O `raw`
  guarda o mínimo necessário, não o texto inteiro do documento.
- Limite de bytes configurável (`EVIDENCE_ANALYSIS_MAX_BYTES`, default igual ao
  limite do artefato) e conferência de SHA-256 antes da análise. A extração de
  texto usa `unpdf`/PDF.js e o analyzer limita páginas (50), texto
  (1.000.000 caracteres) e tamanho dos campos `raw`, evitando amplificação de
  storage. O parsing de streams/fontes fica na biblioteca (ADR-0039).

## Alternativas rejeitadas

1. **Criar uma nova linha em `claim_evidence` com o resultado.** O índice
   parcial permite só um `customer_submitted_document` por claim; uma segunda
   fonte artificial contaria a mesma prova duas vezes no score e misturaria
   análise com verificação.
2. **Atualizar `claim_evidence.detail`.** O trigger de imutabilidade impede e
   reescrever a observação destruiria a auditoria.
3. **Guardar o resultado em `evidence_artifact`.** O artefato é write-once e
   representa o binário; misturar extração com matéria-prima impede versionar
   analisador/contrato.
4. **Tabela de documento/tentativa (`uploaded_document`,
   `verification_attempt`).** Duplicaria o artefato e o vínculo com o claim,
   sem necessidade nesta etapa.
5. **Dependência de OCR/VLM agora.** Aumentaria custo, superfície de PII e
   variabilidade sem contrato de verificação. O protocolo permite trocar a
   implementação depois.
6. **Manter um parser PDF próprio.** Rejeitado no ADR-0039: parsing é
   commodity, o subconjunto caseiro era incompleto e aumentava a superfície de
   segurança sem melhorar o contrato.

## Consequências

- O `GET /v1/validations/:id` continua mostrando `evidence_summary.unknown`; o
  detalhe analisado **não** é exposto nesta etapa. Expor isso é uma decisão de
  contrato público da F1.3 (ou posterior), não um efeito colateral da F1.2.
- A extração de texto é deliberadamente conservadora. PDFs com fontes sem
  `ToUnicode`, layout não textual ou digitalizações podem retornar
  `inconclusive`/`NO_TEXT_LAYER`; campos não rotulados ou ambíguos ficam
  `null`/`not_extracted`. Não inventamos campos nem usamos lista de empresas
  para classificar o documento.
- Não há retry automático de resultado terminal `unavailable`/`failed`. Uma
  nova tentativa exige nova versão de analisador/contrato (ou intervenção
  operacional); isso preserva a imutabilidade do resultado. O retry seguro
  coberto agora é o de execução/replay: não duplica nem reescreve.
- A saída do analisador é validada por schema e por identidade
  (`analyzer.id`, `version`, `contractVersion`). Saída inválida vira
  `failed`/`INVALID_ANALYZER_OUTPUT` ou `INVALID_ANALYZER_IDENTITY`, não fica
  presa em `analyzing` indefinidamente.
- O loop consome somente a versão injetada. Se o analisador for atualizado,
  linhas `pending` de uma versão anterior não são processadas por esse loop;
  elas exigem um worker/backfill da versão correspondente ou intervenção
  operacional. A F1.3 precisa decidir como versionar a leitura.
- A F1.3 precisa decidir como transformar `evidence_analysis` em
  `claim_evidence`/`stance` e como lidar com múltiplas versões de análise. Essa
  decisão fica explicitamente aberta.
