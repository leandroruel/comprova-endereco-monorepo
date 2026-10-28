# Roadmap canônico — Comprova

> **Status:** documento canônico a partir de 2026-10-22. Última revisão:
> 2026-10-28 — sincronização do estado das fases com `PROGRESS.md` e o código
> mergeado em `main`; reposicionamento para plataforma B2B de comprovação de endereço
> para KYC.
> **Escopo:** produto, arquitetura e prioridades (não é changelog).
> **Changelog:** [`PROGRESS.md`](../PROGRESS.md) continua sendo o log cronológico do
> que foi entregue. Este arquivo diz **o que vem depois, em que ordem e por quê**.
> **Contexto de arquitetura:** [`docs/architecture.md`](architecture.md) (estado
> atual) e [`docs/arquitetura-evidencias.md`](arquitetura-evidencias.md) (alvo de
> evidências e fontes).

## Snapshot de implementação (2026-10-28)

O código mergeado em `main` está à frente do snapshot histórico deste documento:

- **Entregues:** F0.1/F0.2; F1.1/F1.2a/F1.2b/F1.3; F2.1; F2.2a e a
  primeira fatia real da F2.2b (NF3-e/SVRS em produção para RS e SP); F3.1 e
  o vertical slice F3.2 pelo dashboard.
- **Em andamento:** F0 (evento faturável e checklist de produção), F1 (OCR e
  documentos complexos), F2 (expansão/hardening da cobertura fiscal), F3.3
  (medição/cobrança) e F6 (operação/segurança).
- **Próximo passo:** fechar F3.3 e o checklist de produção; a unidade de
  cobrança e as regras de faturamento continuam decisões comerciais abertas.
- **Futuro:** F4 (fluxo do titular), F7 (NFAg-e/outras fontes) e F8 (SSI).
  F5 permanece parcialmente entregue: a camada de credencial existe, mas ainda
  faltam decisões e o kit de verificação do produto.

Este snapshot não transforma uma primeira fatia em cobertura nacional: a
consulta fiscal continua explicitamente limitada ao autorizador SVRS e às UFs
RS/SP suportadas pelo adapter.

## Por que este arquivo existe

Até 2026-10-22 o repositório **não tinha roadmap versionado**. O que existia era:

- `PROGRESS.md`, um log cronológico por entrega;
- referências a um "roadmap #24, etapa 24.x" dentro de `PROGRESS.md` e de ADRs
  (por exemplo [ADR-0031](adr/0031-rotacao-de-chave-de-assinatura.md)), sem o
  documento de origem no repo;
- fases (`fase-*.md`) e ADRs, que registram decisões passadas, não prioridades
  futuras.

Isso tornava impossível responder "o que é P0?", "o que foi adiado?" e "por que
SSI não é agora?" sem reconstruir a intenção. Este arquivo passa a ser a **única
fonte canônica de prioridades**. O roadmap #24 anterior está mapeado em
[Revisão crítica](#revisão-crítica-do-que-existia): ele foi **absorvido**, não
substituído por um segundo roadmap concorrente.

## Produto-alvo

O Comprova é uma plataforma B2B de **comprovação de endereço para bancos,
fintechs e empresas que fazem KYC**, com cobrança por consulta.

O cliente corporativo solicita uma comprovação sobre um titular/endereço. O
titular fornece evidências; o Comprova coleta, verifica, aplica policy e devolve
um resultado explicável. **O comprovante enviado pelo titular é apenas uma das
fontes de evidência**, não o centro do produto.

O produto final precisa:

- aceitar fontes heterogêneas (documento do titular, NF3e/NFAg-e, cadastro,
  geolocalização/POI e fontes futuras) sem criar um domínio novo para cada uma;
- tratar todas como **Evidence Sources** que convergem para uma observação e um
  resultado de verificação comuns;
- separar `document`, `address` e `holder` em dimensões independentes;
- transformar observações em `EvidenceVerificationResult` com estados
  explícitos, nunca em um booleano "confere/não confere";
- aplicar policy/scoring para produzir `verdict` e `score`, com explicação;
- entregar o resultado ao cliente e, opcionalmente, uma credencial verificável;
- cobrar por consulta, com evento faturável auditável e sem contar retry/replay
  duas vezes.

## Arquitetura-alvo

```text
                    Evidence Sources
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    Documento enviado   Fonte fiscal     outras fontes
          │                │
          └────────────────┼────────────────┘
                           ▼
                 EvidenceObservation
                           ▼
                 Verification adapters
                           ▼
                document / address / holder
                           ▼
                     Policy Engine
                           ▼
                  verdict + score
                           ▼
                    VC / resultado
```

Princípios vinculantes:

1. **Fonte não é claim.** Uma fonte de evidência é um adaptador
   (`EvidenceSourceAdapter`) que coleta/normaliza dados e devolve um
   `EvidenceVerificationResult`. Não se cria `claim.type = nf3e` nem uma tabela
   por tipo de documento.
2. **Observação não é verificação.** A extração produz uma leitura não confiável
   (`EvidenceObservation`/`DocumentAnalysisResult`). A verificação compara com o
   `claim`, autentica o documento e consulta fontes externas.
3. **Verificação não é policy.** O adaptador informa as dimensões; a policy
   decide `stance`, peso e veredito.
4. **Credencial não é evidência.** A credencial é uma saída assinada do
   resultado, não uma fonte de verdade nem um pré-requisito do MVP comercial.
5. **As três dimensões são independentes.** Um documento autêntico pode ter
   endereço diferente do claim; um endereço correto pode estar no nome de outra
   pessoa. Nunca colapsar em um booleano.
6. **Indisponibilidade não é contradição.** `unavailable`, `inconclusive` e
   `unsupported` nunca viram `contradicts`.
7. **Reuso antes de entidade nova.** A observação intermediária continua em
   `evidence_analysis`; a verificação continua em `claim_evidence.detail`; o
   material continua em `evidence`/`evidence_artifact`. Nenhuma tabela nova por
   fonte sem necessidade demonstrada.

### Evidence Sources

| Fonte (`source.kind`) | Exemplos                                             | Estado no roadmap                                         |
| --------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `uploaded_document`   | comprovante de luz/água/telefone, contrato           | F1.1/F1.2 entregues; verificação na F1.3                  |
| `fiscal_nf3e`         | NF3e (modelo 66)                                     | F2: primeiro adaptador externo                            |
| `fiscal_nfag`         | NFAg-e (modelo 75)                                   | F7: adaptador com gate regulatório                        |
| `public_registry`     | Receita, CNEFE, CEP                                  | fast path existente; uniformização futura                 |
| `geolocation_poi`     | fachada/street view, POI, geolocalização             | deep path existente; uniformização futura                 |
| outras                | fontes cadastrais, fiscais ou de mercado autorizadas | somente com demanda, contrato e direito de uso confirmado |

O roadmap **não promete cobertura fiscal nacional**. A cobertura é declarada por
autorizador/fonte, com allowlist e testes. Uma fonte nova é um adaptador novo,
não uma nova fase de domínio.

## Fronteiras conceituais

| Etapa                 | Pergunta                                                      | Saída                                    | Não é                              |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| Intake                | O arquivo foi recebido e armazenado com segurança?            | `evidence_artifact`                      | autenticidade, endereço ou titular |
| Extração (F1.2a)      | Que texto/estrutura existe no artefato?                       | texto/estrutura/observações              | entendimento do documento          |
| Entendimento (F1.2b)  | Que tipo, endereço, titular e datas o documento declara?      | `DocumentAnalysisResult`                 | verificação, matching ou score     |
| Verificação (F1.3/F2) | O documento é autêntico? O endereço/titular confere?          | `EvidenceVerificationResult`             | policy, veredito ou credencial     |
| Policy/scoring (F3)   | Quanto isso sustenta ou contradiz o claim?                    | `stance`, `score`, `verdict`, explicação | credencial                         |
| Credencial (F5)       | Como entregar um resultado verificável de forma independente? | VC/recibo assinado                       | evidência ou fonte de verdade      |

```text
upload ≠ extraction ≠ verification
```

- **Upload** só recebe, valida limite/tipo por conteúdo e guarda.
- **Extraction** obtém texto/estrutura do artefato.
- **Understanding** interpreta campos e normaliza endereço/titular/datas.
- **Verification** compara com o `claim`, consulta fontes externas e produz as
  três dimensões.
- A análise **nunca** produz `authentic`, `matches` ou `differs`; esses valores
  pertencem ao verificador.

## Fluxo comercial

```text
Empresa cliente
      ↓
solicita consulta
      ↓
titular envia comprovante (link/token seguro)
      ↓
Comprova coleta evidências
      ↓
verifica fontes
      ↓
policy
      ↓
score/verdict
      ↓
resultado para empresa
      ↓
cobrança da consulta
```

- A **consulta** é a unidade comercial candidata. A unidade exata de cobrança
  (consulta, validation técnica, documento, fonte consultada ou relatório) é
  **decisão de produto pendente**; este roadmap não a fecha.
- Uma consulta pode envolver mais de uma fonte e mais de uma execução técnica.
  O evento faturável deve ser idempotente e vinculado ao resultado entregue.
- Retry/replay não geram nova cobrança. Recomendação: fonte `unavailable` também
  não é faturável; a regra final é decisão comercial da F3.
- O resultado entregue deve explicar quais fontes foram consultadas, quais
  dimensões foram confirmadas/contraditas e quais ficaram desconhecidas.
- O cliente corporativo não recebe PII bruta por padrão; recebe o resultado e a
  explicação permitida pelo contrato.

## Fluxo do titular

```text
empresa solicita comprovação
        ↓
link/token seguro
        ↓
titular
        ↓
upload
        ↓
análise/verificação
        ↓
resultado associado à consulta
```

- O link/token é opaco, single-use, com expiração, vinculado a tenant + subject +
  consulta/validation de origem, com rate limit e auditoria.
- Nenhum dado pessoal (CPF/CNPJ, endereço, documento) vai na URL.
- A autenticação do titular (gov.br, OTP, magic link ou outra) é decisão de
  produto da F4; wallet não é requisito.
- O consentimento deve ter versão, timestamp e finalidade; `consent_ref` como
  string opaca não é prova suficiente.
- O upload reutiliza o intake F1.1 e a análise F1.2a/F1.2b; a verificação
  reutiliza F1.3/F2.
- O resultado fica associado à consulta original. Uma atualização cria novo
  resultado/histórico; nunca sobrescreve a validação ou credencial anterior.
- Atualização não é contestação: contestação é um fluxo próprio e não se
  confunde com nova evidência.

## Legenda de prioridade

| Nível  | Significado                                      | Critério de entrada                                                        |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------- |
| **P0** | Segurança, integridade ou bloqueio de lançamento | Sem isso, uma fonte nova ou um documento de cliente cria risco inaceitável |
| **P1** | Valor comercial inicial                          | Destrava a primeira entrega paga ou o requisito de produto já confirmado   |
| **P2** | Pós-primeira entrega                             | Aumenta retenção/margem, mas o produto funciona sem                        |
| **P3** | Expansão futura                                  | Depende de demanda comprovada ou de ato/norma externos                     |

Regra de ouro: **uma fase só começa quando as dependências estão verdes e as
decisões abertas daquela fase foram tomadas**. Não se abre fase nova para
"aproveitar" refactor.

## Grafo de dependências

```text
F0 (baseline P0)
 └──► F1 (evidência documental)
       F1.1 intake
         └──► F1.2a extração
               └──► F1.2b entendimento
                     └──► F1.3 verificação
                           └──► F2 (fontes de evidência e adaptadores; NF3e primeiro)
                                 └──► F3 (policy/scoring + produto comercial + cobrança)
                                       ├──► F4 (fluxo do titular/atualização)
                                       ├──► F5 (credencial como saída)
                                       └──► F6 (operação/segurança contínua)
F2 ──► F7 (expansão de fontes: NFAg-e e outras; P3 com gate)
F5 ──► F8 (SSI: OID4VCI/VP/wallet; P3 com demanda)
```

Paralelismo permitido:

- F1.3 pode começar assim que o contrato de análise estiver estável; não precisa
  esperar todas as fontes externas.
- F3 pode evoluir junto de F2 depois que o `EvidenceVerificationResult` estiver
  definido, mas o scoring final não deve fechar antes da primeira fonte externa.
- F4 e F5 podem rodar em paralelo depois do núcleo de F3; nenhuma das duas é
  pré-requisito para a primeira entrega paga.
- F6 é contínua desde F0; não é uma fase "depois do produto".
- F7 e F8 são gated e não bloqueiam o MVP comercial.

---

## Fase 0 — Baseline de produção e integridade (P0)

**Objetivo:** fechar as lacunas que tornam inseguro aceitar documento de cliente
ou consultar fonte externa. Nenhuma feature nova de produto.

### Estado atual comprovado

| Item                      | Evidência                                                                                                        | Situação                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotência de validação | `apps/api/src/services/fastpath.ts` (`findExistingIdempotency`, `requestHashOf`) + `validation_idempotency`      | Funciona; replay não reescreve e não reemite `usage_event`                                                                               |
| RLS multi-tenant          | `packages/db/migrations/0007_rls.sql`, `withTenant`                                                              | FORCE em `subject`, `validation`, `claim`, `claim_evidence`, `usage_event`, `audit_log`, `webhook_*`, `batch*`                           |
| Retenção de validação     | `apps/worker/src/modules/retention/retention.service.ts` + loop em `apps/worker/src/loops.ts`                    | Job diário existe e apaga o grafo                                                                                                        |
| Guarda de fetch externo   | `packages/providers/src/safe-fetch.ts`, [ADR-0036](adr/0036-guarda-de-fetch-externo.md)                          | **Entregue em F0.2**: HTTPS, DNS resolvido, todos os IPs validados e fixados, sem redirect, limites e content-type; webhook usa no envio |
| `evidence` global         | `packages/db/migrations/0005_validation.sql`, `0007_rls.sql`, `0008_grants.sql`                                  | **Sem `tenant_id`/RLS**; único escritor hoje é o VLM de street view (`apps/worker/src/modules/evidence/evidence.service.ts`)             |
| Artefato de PII           | `packages/db/migrations/0039_evidence_artifact.sql`, [ADR-0035](adr/0035-artefato-de-evidencia-tenant-scoped.md) | **Entregue em F0.1**: `evidence_artifact` tenant-scoped, RLS FORCE, write-once; intake em F1.1 e análise em F1.2a/F1.2b                  |
| Expiração de validação    | `fastpath.ts` (`expires_at = now + 30d`)                                                                         | 30 dias hardcoded, não vem da policy                                                                                                     |
| Dashboard e API key       | `apps/dashboard/src/api/client.ts`                                                                               | Chave de tenant vai no bundle do browser; o próprio código marca como "facilidade de desenvolvimento"                                    |

### Lacunas

1. **Guarda de fetch genérica entregue em F0.2.** `safeExternalFetch`
   (`packages/providers/src/safe-fetch.ts`) resolve/valida todos os IPs, fixa o
   IP na conexão, exige HTTPS, não segue redirect e limita
   tempo/corpo/content-type; o webhook e a primeira consulta fiscal já a usam.
   A allowlist fiscal tem a primeira entrada SVRS em produção para RS/SP;
   expansão e hardening continuam em F2 (ADR-0034).
2. **`evidence` é global por design**, o que é correto para imagem pública de
   street view e **incorreto** para comprovante com dado pessoal do cliente. A
   fundação tenant-scoped foi entregue em F0.1 (`evidence_artifact`, ADR-0035);
   o intake, a análise e a verificação com PII foram entregues em F1.1/F1.2/F1.3.
   OCR e fontes externas adicionais continuam em F2.
3. **Não há checklist de produção** para issuer origin definitivo, KMS por
   tenant, restore de backup, alarmes e capacidade.

### Escopo

- ~~Desenhar e testar uma guarda de fetch reutilizável (resolução DNS com
  bloqueio de faixas privadas/link-local/metadata, sem redirect, limites de
  tempo/tamanho/content-type, IP fixado na conexão)~~ **Entregue em F0.2**:
  `safeExternalFetch` no `packages/providers`, aplicada ao webhook no envio
  (ADR-0036). A allowlist por autorizador fiscal fica em F2 (ADR-0034).
- ~~Decidir o escopo tenant de artefato enviado pelo cliente~~ **Entregue em
  F0.1**: `evidence_artifact` tenant-scoped, RLS FORCE e FK composta. A remoção
  atual ocorre no fluxo de retenção após a expiração da validação;
  `retention_until` ainda não define o prazo comercial do binário (ADR-0035;
  migration 0039).
- Definir o **evento faturável canônico** (uma consulta nova = no máximo um
  evento; replay/retry = zero) antes de F3 implementar.

### Fora de escopo

- Endpoint de upload, OCR, consulta fiscal, OID4VCI/VP, wallet.
- Refactor preventivo de módulos que não serão tocados.

### Critérios de conclusão

- ~~Testes negativos da guarda de fetch: `localhost`, `127.0.0.1`, `169.254.169.254`,
  RFC1918, IPv6 loopback, host que resolve para IP privado, redirect para host
  privado, corpo acima do limite, `content-type` fora da allowlist.~~
  **Entregue em F0.2** (`packages/providers/src/safe-fetch.test.ts` e
  `apps/api/tests/modules/webhooks/webhook-safe-fetch.int.test.ts`).
- Teste provando que um artefato de um tenant não é legível por outro.
- `docs/lgpd/retencao.md` e README alinhados ao código (verificação por revisão
  e por link).
- Checklist de produção anexado a este roadmap ou a um runbook.

### Riscos

- Escolher errado o modelo de `evidence` contamina F1/F2 e gera migração
  dolorosa depois. **É a decisão mais importante desta fase.**
- Guarda de fetch mal implementada dá falsa sensação de segurança. Mitigação
  F0.2: validação de todos os IPs, `lookup` fixado, testes de rebinding e
  ausência de opção de bypass no caller.

### Decisões abertas

- ~~`evidence` ganha `tenant_id` + RLS, ou documentos de cliente vão para uma
  tabela nova (`evidence_artifact`) e `evidence` fica só para captura pública?~~
  **Decidido em F0.1:** tabela nova `evidence_artifact`; `evidence` fica só para
  captura pública (ADR-0035).
- ~~Guardamos o binário original ou só hash + campos extraídos?~~ **Decidido na
  fundação:** objeto no storage privado + metadados no banco; o prazo comercial de
  retenção permanece aberto.
- O `expires_at` de 30 dias vira campo de policy ou continua constante?

---

## Fase 1 — Evidência documental: intake, extração, entendimento e verificação (P1)

**Objetivo:** receber um documento de comprovante, extrair texto/estrutura,
entender os campos e, na F1.3, verificar as três dimensões contra o `claim` e as
fontes disponíveis. O comprovante é **uma fonte**, não o produto.

A divisão F1.2a/F1.2b é **conceitual e de responsabilidade**. No MVP atual, as
duas etapas são executadas pelo mesmo `DocumentAnalyzer` e produzem um único
`DocumentAnalysisResult`; a separação permite substituir parser/OCR sem mexer no
entendimento e vice-versa. A F1.3 foi entregue em 2026-10-23; OCR e formatos
complexos continuam como evolução da fase.

### F1.1 — Intake seguro do comprovante (entregue em 2026-10-22)

- `POST /v1/validations/:id/evidence`, multipart, `validate:write`; tenant só da
  API key e validação de outro tenant responde `404`.
- PDF/JPEG/PNG detectados por **magic bytes**; filename/extensão/`Content-Type`
  não definem o tipo. Limite default de 50 MiB, configurável para baixo por
  `EVIDENCE_MAX_BYTES`, aplicado pelo parser e pelo buffer do handler.
- Objeto privado no `ObjectStore` existente em
  `tenants/<tenant>/evidence/<artifact-id>`, SHA-256 calculado no servidor e
  conferido com o storage; nenhuma URL pública.
- `validation → claim → claim_evidence → evidence_artifact` na mesma transação,
  com `source = customer_submitted_document`, `stance = unknown`, `strength = 0`
  e `detail.verification.status = "pending"` (documento recebido, não
  autenticado). Claim ausente em validation legada é criada na transação.
- Um documento do cliente por claim; mesmos bytes são replay `200`, bytes
  diferentes são `409 EVIDENCE_ALREADY_EXISTS`. `Idempotency-Key` opcional
  reutiliza `validation_idempotency` com namespace próprio.
- Lock da validation + índice único parcial serializam concorrência. Um semáforo
  por processo (`EVIDENCE_MAX_CONCURRENCY`, default 4) limita uploads em voo
  antes do buffer. Falha de DB/claim/artifact após o storage apaga o objeto
  (compensação); falha do próprio delete é logada sem PII.
- `retention_until`/`expires_at` derivam de `validation.expires_at`; o job de
  retenção existente remove objeto e grafo.
- Contrato detalhado em
  [`arquitetura-evidencias.md`](arquitetura-evidencias.md#52-intake-do-comprovante-do-cliente-f11-implementado)
  e [ADR-0037](adr/0037-intake-de-comprovante-do-cliente.md).

### F1.2a — Document intake/extraction (entregue no MVP F1.2)

**Responsabilidade:**

```text
artifact
  ↓
document analyzer
  ↓
texto/estrutura/observações
```

- O intake enfileira `evidence_analysis` (`pending`) na mesma transação do
  artefato. O worker consome a fila com `FOR UPDATE SKIP LOCKED`, sem Redis,
  Temporal ou endpoint público de análise.
- O worker lê o objeto privado pelo `storage_key` opaco, confere tamanho/SHA-256
  e executa o `DocumentAnalyzer`.
- MVP: PDF textual extraído localmente (streams simples/`FlateDecode`);
  imagem retorna `unsupported`/`OCR_NOT_IMPLEMENTED`. Nenhum provider externo,
  URL ou VLM é acionado nesta etapa.
- O parser PDF é conservador: PDFs escaneados, fontes CID/Type0 sem `ToUnicode`
  ou layout complexo retornam `inconclusive`/`NO_TEXT_LAYER`.
- A saída é validada por schema e identidade do analisador. Saída inválida vira
  `failed`, não fica presa em `analyzing`.
- **Isto é um adaptador técnico, não uma capacidade central do produto.** O
  protocolo `DocumentAnalyzer` permite trocar por OCR/VLM/parser dedicado sem
  mudar o contrato de entendimento.

### F1.2b — Document understanding (entregue no MVP F1.2)

**Responsabilidade:**

```text
texto/estrutura
  ↓
tipo de documento
endereço
titular
datas
outros campos relevantes
```

- Contrato `DocumentAnalysisResult` separa `document`, `address` e `holder` e
  produz apenas observações não confiáveis. Para `document`:
  `analyzed | invalid | inconclusive | unsupported | unavailable`; para
  `address`/`holder`: `extracted | not_extracted | unknown`. Nunca produz
  `authentic`, `matches` ou `differs`.
- Endereço extraído/normalizado (`logradouro`, `numero`, `complemento`,
  `bairro`, `cidade`, `uf`, `cep`) com `raw` mínimo para auditoria. Ausência de
  endereço é `not_extracted`, não falha.
- Titular só quando claramente rotulado; CPF/CNPJ só quando válido, tratado como
  PII. Não se infere CPF/CNPJ, parentesco, propriedade ou residência.
- Datas de emissão/competência são extraídas de forma conservadora; documento
  antigo não é automaticamente inválido.
- Idempotência por
  `(artifact_id, analyzer, analyzer_version, contract_version)`: replay/retry
  não duplica e não reescreve resultado terminal; nova versão preserva a
  anterior.
- `evidence_analysis` é append-only, tenant-scoped (RLS FORCE), com FK composta
  e `ON DELETE CASCADE` na retenção. Logs não incluem conteúdo/PII.
- Contrato em [ADR-0038](adr/0038-analise-de-documento-do-cliente.md) e
  [`arquitetura-evidencias.md`](arquitetura-evidencias.md#53-análise-do-documento-do-cliente-f12-implementado).

### F1.3 — Verification (P1, entregue em 2026-10-23)

**Responsabilidade:**

```text
observações
+
claim
+
fontes externas
↓
EvidenceVerificationResult
```

- Definir o contrato estável do verificador (ADR-0033) e exercitá-lo primeiro
  com o documento já disponível. A primeira fonte externa real é NF3e (F2).
  **Nota de sequenciamento:** o ADR-0033 previa NF3e como primeira implementação
  real; este roadmap revisa a ordem — o contrato nasce com o documento (F1.3) e
  NF3e é a primeira fonte externa (F2). O contrato e as regras do ADR-0033 não
  mudam.
- Consumir `evidence_analysis` sem tratá-la como `claim_evidence`: a extração é
  intermediária, versionada e não entra no score por si só.
- Comparar endereço/titular do documento com o `claim`/`canonical_address` e
  produzir as dimensões independentes `document`, `address` e `holder`.
- Materializar **uma** linha em `claim_evidence` por fonte consultada, com as
  dimensões e a explicação em `detail`; não criar uma linha por dimensão.
- `unavailable`, `inconclusive` e `unsupported` mapeiam para `unknown` e nunca
  para `contradicts`. `invalid`/`not_found` só contradizem quando a invalidade
  ou a ausência for definitiva e a consulta tiver sido conclusiva.
- Decidir como lidar com múltiplas versões de análise e qual versão é a leitura
  corrente.
- Expor o detalhe do resultado no `GET /v1/validations/:id` (hoje a observação
  aparece apenas em `evidence_summary.unknown`); o contrato público é decisão
  explícita desta etapa.
- Não contar a mesma prova duas vezes: o score continua sendo
  `stance × strength × confidence × decay × weight`, com deduplicação por
  fonte/grupo quando necessário.

**Estado:** o contrato, o matching nas três dimensões, a materialização em
`claim_evidence`, o detalhe no `GET` e a regra de versões foram implementados.
As lacunas restantes da fase são OCR, formatos complexos e decisões de policy
de produto; elas não bloqueiam o vertical slice atual.

### Ainda falta para concluir a Fase 1

- OCR de imagem e mais formatos de documento.
- Política de "documento autêntico ≠ titular mora aqui"; a separação existe no
  contrato, mas a decisão de produto é F1.3/F3.

### Estado atual comprovado

| Item                           | Evidência                                                                                      | Situação                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Endpoint de upload             | `apps/api/src/modules/validations/validations.routes.ts` (`POST /v1/validations/:id/evidence`) | **Entregue em F1.1**: `validate:write`, tenant da key, 404 cross-tenant    |
| Multipart / parsing de arquivo | `@fastify/multipart` + `evidence-intake.multipart.ts`                                          | **Entregue em F1.1**: um arquivo, limite explícito, streaming              |
| Identificação do tipo          | `evidence-intake.service.ts` (`detectEvidenceIntakeContentType`)                               | **Entregue em F1.1**: PDF/JPEG/PNG por magic bytes                         |
| Extração (F1.2a)               | `packages/providers/src/document-analyzer/`, `pdf-text.ts`                                     | **Entregue em F1.2**: PDF textual local; imagem `unsupported` (OCR futuro) |
| Entendimento (F1.2b)           | `document-analyzer/fields.ts`, `schema.ts`                                                     | **Entregue em F1.2**: endereço/titular/datas; sem inferência               |
| Persistência de evidência      | `packages/db/migrations/0039`, `0040`, `0041_evidence_analysis.sql`                            | **Entregue em F1.1/F1.2**: artefato + análise append-only                  |
| Vínculo com claim              | `claim_evidence` (`stance`, `strength`, `confidence`, `detail`) + `evidence_analysis`          | **F1.1/F1.2**: intake `unknown`/pending; extração não entra no score       |
| Análise idempotente            | `apps/worker/src/modules/evidence-analysis/`                                                   | **Entregue em F1.2**: fila no Postgres, lock de linha + chave única        |
| Verificação (F1.3)             | `apps/worker/src/modules/evidence-verification/`                                               | **Entregue em 2026-10-23**: matching, materialização, GET e idempotência   |

### Lacunas

1. **OCR de imagem e formatos complexos:** o MVP cobre apenas PDF textual; não
   há provider/limites/consentimento definidos para OCR/VLM.
2. **Independência de score:** `weightedScore` é aditivo e ainda não deduplica
   por fonte/grupo; a F3 decide `SCORER_VERSION=2` quando houver a segunda fonte
   externa.
3. **Documento autêntico ≠ titular mora aqui:** a separação de dimensões existe,
   mas a política de vínculo com o titular é F1.3/F3.

### Escopo

- ~~Endpoint autenticado e com scope, idempotente, com limite de tamanho e
  allowlist de content-type **verificada por sniffing**, não por header.~~
  **Entregue em F1.1.**
- ~~Storage privado (S3/R2) com chave por tenant e retenção explícita; gravar
  `sha256` e metadados.~~ **Entregue em F1.1**, reutilizando o `ObjectStore` e a
  retenção da F0.1.
- ~~Extração de texto/estrutura (PDF textual; imagem como `unsupported`).~~
  **Entregue em F1.2a** para PDF textual; OCR é evolução futura.
- ~~Entendimento e normalização: tipo, titular, endereço, data de
  emissão/competência.~~ **Entregue em F1.2b** para PDF textual, com resultado
  não confiável e `not_extracted` quando ausente.
- **F1.3:** contrato de verificação, matching em três dimensões independentes,
  mapeamento para `claim_evidence`/`stance`, detalhe no `GET`.
- Manter a análise explicitamente separada de autenticidade, matching e score.

### Fora de escopo

- Consulta a autorizador fiscal (F2).
- Detecção de fraude/adulteração por modelo próprio.
- Revisão humana como produto (pode existir como operação interna).
- Emissão de credencial a partir do upload sem verificação.
- Tratar o parser PDF como capacidade central ou diferencial do produto.

### Critérios de conclusão

- ~~Fixtures sintéticas (não PII real) para PDF e imagem, com teste de tipo
  errado, arquivo corrompido, acima do limite e cross-tenant.~~ **Entregue em
  F1.1** (`apps/api/tests/evidence-intake.int.test.ts`).
- ~~Retry idempotente não cria `claim_evidence` duplicado.~~ **Entregue em
  F1.1**, incluindo concorrência, `Idempotency-Key` e índice único parcial.
- ~~Nenhum dado pessoal em log; `doc_hmac` continua sendo o identificador do
  subject.~~ **Entregue em F1.1**: logs usam apenas ids técnicos/razões e o
  teste cobre filename/conteúdo/API key.
- ~~Extração e resultado tipado completos.~~ **Entregue em F1.2a/F1.2b**: PDF
  textual, endereço/titular/competência, `evidence_analysis` idempotente, testes
  de inválido/unsupported/unavailable/retry/concorrência/cross-tenant/PII/retenção
  (`apps/api/tests/evidence-analysis.int.test.ts`).
- **F1.3:** para cada dimensão, fixture → outcome correto; `unavailable`,
  `inconclusive` e `unsupported` nunca viram `contradicts`; `evidence_analysis`
  consumida sem duplicar a observação F1.1; teste de múltiplas versões; teste de
  cross-tenant e de idempotência da materialização.

### Riscos

- OCR de baixa qualidade gera falso `not_extracted`/`inconclusive`. Mitigação:
  resultado explícito e confiança baixa, nunca `contradicts`.
- Custo de storage e LGPD se o binário for retido sem necessidade.
- Confundir extração com autenticidade: um PDF legível não é um documento
  autêntico. Mitigação: contratos separados e taxonomia explícita.
- Múltiplas versões de análise podem produzir leituras divergentes; a F1.3
  precisa escolher a versão corrente de forma auditável.

### Decisões abertas

- **F1.3:** como consumir `evidence_analysis` e materializar a verificação em
  `claim_evidence` sem duplicar a observação F1.1 nem contar a mesma prova duas
  vezes; como lidar com múltiplas versões de análise.
- **OCR de imagem:** provider/limites/consentimento de PII continuam em aberto.
- ~~Biblioteca de OCR/PDF.~~ **Decidido em F1.2:** MVP sem dependência externa
  de PDF; o parser local cobre PDF textual simples. PDFs complexos retornam
  `inconclusive` e uma biblioteca pode substituir a implementação atrás de
  `DocumentAnalyzer` quando houver necessidade comprovada.
- ~~Guardar binário ou apenas hash + campos?~~ **Decidido em F0.1/F1.1:**
  binário no `ObjectStore` privado + `sha256`/metadados; nenhum blob no Postgres.
- ~~Upload cria validação nova ou anexa a uma validação existente?~~ **Decidido
  em F1.1:** anexa à validation existente, um documento do cliente por claim;
  troca/substituição exige nova validation ou decisão futura de supersessão
  (F4).

---

## Fase 2 — Fontes de evidência e adaptadores externos (P1, após F1.3)

**Objetivo:** adicionar fontes externas sem criar tipos especiais de `claim` nem
domínio paralelo. O contrato `EvidenceSourceAdapter` (equivalente ao
`EvidenceVerifier` do ADR-0033) recebe a entrada da fonte e devolve um
`EvidenceVerificationResult` com as três dimensões. NF3e é a primeira fonte
externa real; o documento já exercita o contrato na F1.3.

### Contrato e taxonomia

```text
EvidenceSourceAdapter
        ↓
EvidenceVerificationResult
  source      { kind, id, authority, environment }
  method      content_extraction | official_qr_consultation |
              official_xml_signature | manual_review
  document    authentic | not_found | invalid | inconclusive |
              unavailable | unsupported
  address     matches | differs | not_extracted
  holder      matches | differs | not_extracted
  documentRef, queriedAt, issuedAt, limitations, errorCodes, artifact, audit
```

Regras:

- Uma fonte é um adaptador, não um `claim.type`. NF3e/NFAg-e não são tipos de
  claim; são fontes que produzem observações de verificação.
- `document`, `address` e `holder` são independentes. O adaptador informa; a F3
  decide o `stance`.
- Quando a fonte não permite comparar endereço/titular, a dimensão fica
  `not_extracted` e a policy trata como `unknown`. Nunca `differs`.
- `unavailable`, `inconclusive` e `unsupported` nunca viram `contradicts`.
- Uma observação por fonte em `claim_evidence`; não criar tabela de documento,
  tentativa ou fonte. O `detail` jsonb continua sendo o lugar de evolução.
- Respostas externas são normalizadas no adaptador; a resposta bruta não vira
  contrato público nem entra em log.

### NF3e (modelo 66)

Fatos externos verificados em 2026-10-22:

| Fonte                          | Fato                                                                                                         | Implicação                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| NF3e (modelo 66)               | Ajuste SINIEF 01/19; obrigatória; SP exige desde 01/10/2025 (Portaria SRE 42/2025)                           | Há documento real a verificar                                             |
| Autorizadores NF3e em produção | MG, MS, MT, PR, SVRS, SC                                                                                     | **Não há cobertura nacional uniforme**; o endpoint depende do autorizador |
| QR Code NF3e                   | URL difere por autorizador (ex.: `dfe-portal.svrs.rs.gov.br/nf3e/qrCode`, `sat.sef.sc.gov.br/nf3e/consulta`) | **Nunca** fazer fetch da URL do QR                                        |
| Portal SVRS                    | A página de MS aponta o QR para um WSDL                                                                      | Fonte de dados tem inconsistência; não hardcodar de uma leitura           |
| Autorização fiscal             | Valida forma/assinatura/layout, **não o mérito dos dados**                                                   | Documento autêntico **não** prova residência                              |

Fontes: [FAQ NF3e SVRS](https://dfe-portal.svrs.rs.gov.br/Nf3e/Faq),
[Serviços NF3e](https://dfe-portal.svrs.rs.gov.br/Nf3e/Servicos),
[NF3e SEFAZ-SP](https://portal.fazenda.sp.gov.br/servicos/nf3e). Consultadas em
2026-10-22. O que **não** está confirmado: exigência de certificado para a
consulta pública por QR, termos de uso de consulta automatizada e o autorizador
efetivo de SP (SP não aparece como ambiente próprio na página de serviços).

### F2.2a — normalização da referência fiscal/QR (entregue)

- `FiscalReference` em `packages/core/src/fiscal-reference.ts` descreve uma
  referência **já extraída** com `found`/`not_found`/`inconclusive`/
  `unsupported`, fonte, autorizador, UF, URL normalizada, chave, método,
  limitações e fingerprint. Não há score, confiança, autenticidade nem decisão.
  O contrato é `FISCAL_REFERENCE_CONTRACT_VERSION = '2'`.
- `extractFiscalReference` em `packages/providers/src/fiscal/reference.ts`
  reconhece NF3e por estrutura: autorizador documentado com o caminho esperado
  do endpoint de QR e/ou chave de 44 dígitos estritamente numérica com UF,
  modelo `66` e DV módulo 11. Domínio ou caminho desconhecido não vira
  autorizador; NFAg-e é `unsupported`.
- `toFiscalLookupInput(reference, context)` usa tenant/claim/artefato do
  contexto confiável e só emite input quando há fonte reconhecida.
- Nenhum fetch, HEAD ou DNS lookup; URL do QR é apenas normalizada.

### F2.2b — extração física do QR (parte física entregue)

> **Nota de sequenciamento:** o pedido original chamava esta etapa de "F2.2a".
> No roadmap canônico a F2.2a é a normalização (já entregue); a decodificação
> física da imagem/PDF é a **primeira metade da F2.2b**. A segunda metade foi
> entregue na primeira fatia SVRS/produção para RS e SP; expansão, cache,
> métricas e hardening continuam pendentes.

- `extractFiscalReferenceFromArtifact` em
  `packages/providers/src/fiscal/reference.ts` decodifica QR de **PNG/JPEG** e
  de **imagens raster embutidas em PDF**. O payload decodificado passa pelo
  mesmo `extractFiscalReference`; nenhuma consulta externa é feita.
- Decoder `zxing-wasm` com WASM carregado **do pacote local** (`wasmBinary`),
  sem CDN/fetch; pré-checagem de dimensões com `image-size`. Limites: 16 MP,
  borda 10.000 px, 8 símbolos, 50 páginas e 64 imagens.
- Política determinística para múltiplos QR: duplicata/mesmo fingerprint →
  `found`; referências fiscais distintas → `unsupported`/`AMBIGUOUS_REFERENCE`
  (nunca "o primeiro QR"); QR fiscal único + QR não fiscal → `found` com
  `MULTIPLE_QR_CODES`.
- `inconclusive` cobre QR ilegível (`QR_NOT_READABLE`), imagem corrompida/
  grande, PDF inválido/encriptado e decoder indisponível. PDF sem raster
  inspecionável (ex.: QR vetorial) → `inconclusive`/`PDF_QR_VECTOR_UNSUPPORTED`,
  sem canvas nativo ou renderização de página.
- O `DocumentAnalysisResult` (contrato `3`, analyzer `text_document@1.2.0`)
  ganhou `fiscalReference`; a URL normalizada é **removida antes da
  persistência** (`redactFiscalReference`), preservando `fingerprint` e
  `documentId`. O schema do resultado proíbe `url != null`.
- **Entregue na primeira fatia da F2.2b:** resolver o autorizador no servidor,
  consultar somente o endpoint HTTPS da allowlist SVRS em produção e normalizar
  a resposta com fixtures e testes de indisponibilidade.
- **Ainda pendente:** cache/rate limit por fonte, métricas operacionais,
  expansão para outros autorizadores/UFs e eventuais fixtures adicionais de
  respostas reais.

### Escopo

- Implementar o contrato de adaptador e o registro de fontes suportadas.
- Adaptador NF3e: identificar o documento, extrair/normalizar a referência
  (F2.2a, entregue), decodificar o QR físico (parte física da F2.2b, entregue)
  e, na sequência, resolver o autorizador **no servidor**, consultar somente URL
  da allowlist e normalizar a resposta.
- Tabela de autorizadores versionada em código (UF → autorizador → endpoint de
  consulta → ambiente), com testes por autorizador.
- Estado da fonte (`available`, `degraded`, `unavailable`, `unsupported`) e
  mapeamento para `unknown` — **nunca** `contradicts` por indisponibilidade.
- Fixtures de respostas gravadas; **nenhuma chamada de rede no CI**.
- Métricas por fonte: latência, taxa de `unavailable`, cache hit.
- Declarar explicitamente quais UFs/fontes são suportadas e quais não são.

### Fora de escopo

- NFAg-e (F7, com gate).
- Serviços SOAP de emissão/assinatura (o produto consulta, não emite).
- Cobertura nacional declarada sem autorizador confirmado.
- Validação de assinatura XML como requisito (pode virar P2 se o cliente exigir).
- Criar tabela por fonte ou `claim.type` específico de NF3e/NFAg-e.

### Critérios de conclusão

- Fase física (entregue): QR válido em PNG/JPEG/PDF, QR ausente, QR ilegível,
  conteúdo arbitrário, múltiplos/duplicados/conflitantes, prova de ausência de
  network I/O e de que a referência não altera tenant/claim/artefato.
- Para cada autorizador suportado, fixture → `outcome` correto.
- Teste provando que URL de QR fora da allowlist não gera fetch.
- Teste provando que `source_unavailable` mapeia para `unknown`.
- Teste provando que `document`, `address` e `holder` permanecem independentes.
- Teste de cross-tenant e de idempotência da consulta.
- Latência p95 dentro do orçamento definido (ex.: 5 s) e timeout explícito.
- Documentação de quais UFs são suportadas e de quais não são.

### Riscos

- Instabilidade/HTML cambiante dos portais. Mitigação: contrato + fixtures +
  alarme de regressão, não scraping frágil.
- Aspecto legal/ToS da consulta automatizada.
- Falsa sensação de "cobertura nacional".
- Fonte externa ser tratada como prova de residência. Mitigação: dimensões
  separadas e policy explícita.

### Decisões abertas

- Quais UFs/fontes primeiro? (demanda comercial, não conveniência técnica).
- Consulta pública por QR apenas, ou SOAP com certificado?
- Cachear resposta por chave por quanto tempo? (documento é imutável; cache é
  seguro com TTL e auditoria)
- Guardar o HTML/XML bruto ou só hash + campos normalizados?

---

## Fase 3 — Policy, scoring e produto comercial (P1)

**Objetivo:** transformar `EvidenceVerificationResult` em `verdict`/`score` e
operar a consulta comercial com cobrança auditável. A policy não é fonte; a fonte
não decide o veredito.

**Estado:** F3.1 e o vertical slice F3.2 estão entregues. F3.3 é a próxima
etapa comercial e ainda não está concluída.

### F3.1 — Policy engine e scoring (primeiro slice entregue em 2026-10-25)

- Evoluir a policy/scoring existentes (`evaluateClaim` + `weightedScore` +
  `policies/*.yaml`) para consumir as três dimensões e produzir `stance`,
  `score`, `verdict`, confiança e explicação.
- Mapear as dimensões para `stance` conforme ADR-0033, com regra dura:
  `unavailable`, `inconclusive` e `unsupported` → `unknown`; nunca
  `contradicts`. `invalid`/`not_found` só contradizem quando definitivos e no
  autorizador competente.
- Uma observação por fonte; não somar `document`, `address` e `holder` como se
  fossem três fontes independentes.
- `weightedScore` é aditivo hoje. Quando houver a segunda fonte externa,
  avaliar `SCORER_VERSION=2` com agrupamento/deduplicação por fonte/grupo; não
  bumpar o scorer sem necessidade.
- Policy por cliente/tenant/versão é decisão de produto; o default global pode
  existir, mas o primeiro contrato B2B provavelmente exige versionamento
  explícito.

O primeiro checker fiscal (`nf3e_verification`) já tem força e confiança
versionadas na policy `2026.14.1`; fontes `unsupported`/`unavailable`/
`inconclusive` continuam neutras.

### F3.2 — Fluxo comercial e entrega do resultado (vertical slice entregue em 2026-10-26)

- O cliente corporativo solicita uma consulta; o Comprova cria/associa a
  execução técnica (`validation`) e, quando necessário, o link do titular (F4).
- O resultado entregue contém `verdict`, `score`, confiança, explicação e o
  resumo das evidências/fontes; PII bruta não é exposta por padrão.
- O resultado deve ser reproduzível/auditável e distinguir:
  confirmado, contradito, desconhecido, indisponível e não suportado.
- Replay/retry não geram novo resultado nem nova cobrança.
- O contrato público do resultado (API/dashboard) é definido junto com a F1.3 e
  evolui de forma aditiva.

O dashboard já executa criação, upload, análise, verificação, consulta fiscal,
reavaliação e polling até o resultado estabilizar. O fluxo ainda é single-tenant
de desenvolvimento e não representa cobrança pronta para produção.

### F3.3 — Medição de uso e cobrança

**Estado atual comprovado**

| Item          | Evidência                                                                     | Situação                                                                     |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Evento de uso | `packages/db/src/schemas/usage.ts` (`usage_event`)                            | Existe: tenant, ocorrido em, `kind`, `units`, `cost_micros`, `validation_id` |
| Inserção      | `fastpath.ts` (`kind: 'fast'`), `deep-enrich.persistence.ts` (`kind: 'deep'`) | Uma vez por validação nova; replay não insere                                |
| Planos/cotas  | busca no repo                                                                 | **Não existe**                                                               |
| Ledger/fatura | busca no repo                                                                 | **Não existe**                                                               |
| Stats         | `apps/api/src/modules/stats/stats.service.ts`                                 | Deriva de `validation`, **não** de `usage_event`                             |

**Lacunas**

1. `kind` é texto livre (`'fast'`/`'deep'`) — não há vocabulário estável de
   evento faturável.
2. Não há chave de idempotência/unique em `usage_event`; concorrência ou retry
   pode duplicar em cenários futuros.
3. Não há noção de "evento faturável" separada de "tentativa": fonte
   indisponível, reprocessamento e contestação não têm regra.
4. Cotas/limites por tenant não existem; rate limit não é cota comercial.
5. Stats e cobrança olham fontes diferentes, então podem divergir.

**Escopo**

- Definir o evento canônico (por consulta concluída? por documento? por fonte?)
  e documentar as regras de não cobrança.
- Evoluir `usage_event` de forma aditiva: vocabulário de `kind`, chave de
  idempotência/unique, metadados de fonte/tentativa, flag de faturável.
- Cota por tenant (soft/hard) com auditoria.
- Consulta/exportação de uso reconciliável com `validation`.
- Alarme de divergência entre `usage_event` e consultas concluídas.

**Fora de escopo**

- Gateway de pagamento, nota fiscal, tabela de preços (decisão comercial).
- Rate limit de proteção (já existe; não é cota).

**Critérios de conclusão**

- Teste de concorrência: duas requisições simultâneas com a mesma
  `idempotency-key` geram um evento.
- Reprocessamento e replay não geram evento.
- Consulta de reconciliação bate com `validation` para uma janela.
- Regra de fonte indisponível documentada e testada.
- Unidade de cobrança declarada (mesmo que a decisão seja "pendente" e o evento
  use uma unidade provisória).

**Riscos**

- Cobrar por tentativa desalinhado com valor percebido; cobrar por validação
  quando o cliente faz polling.
- Migração de `usage_event` particionada exige cuidado.
- Unidade de cobrança fechada cedo demais pode distorcer o produto.

**Decisões abertas**

- Unidade de cobrança: consulta, validation, documento único, fonte consultada
  ou relatório.
- Fonte indisponível é faturável? Recomendação: **não**.
- Revalidação do mesmo documento em 30 dias é nova cobrança?
- Quem é o "cliente" no dashboard se todos usam a mesma API key? (ver F6)

---

## Fase 4 — Fluxo do titular e atualização (P1/P2)

**Objetivo:** permitir que a empresa solicite a comprovação e que o titular envie
ou atualize a evidência por um link seguro; o resultado fica associado à consulta
original e o histórico é imutável.

### Estado atual comprovado

| Item                    | Evidência                                                      | Situação                                                    |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Consentimento           | `validation.consent_ref` (texto livre), `contracts/schemas.ts` | **Não é entidade**; não há captura, validade ou prova       |
| Token/link seguro       | busca no repo                                                  | **Não existe**                                              |
| Histórico de validações | `validation` (imutável, nova linha por pedido)                 | Existe como log, **sem vínculo explícito** de substituição  |
| Superação de credencial | `credential-issuance` / deep path                              | Existe para credencial, **não** para o resultado de negócio |

### Lacunas

1. Não há fluxo de identidade do titular (quem recebe o link, como se autentica).
2. `consent_ref` não prova consentimento: é string opaca.
3. Não há como dizer "esta validação substitui aquela" nem "o resultado mudou
   de X para Y".
4. Não há comparação explícita entre evidência antiga e nova.
5. Não há proteção contra link reutilizado, expirado ou usado por outro tenant.
6. O fluxo inicial de coleta do titular não está separado do fluxo de
   atualização.

### Escopo

- Token opaco, single-use, com expiração, vinculado a tenant + subject +
  consulta/validation de origem; rate limit e auditoria.
- Captura de consentimento (versão do texto, timestamp, IP/UA quando aplicável)
  — entidade nova só se necessário.
- Reuso do intake de F1, da análise F1.2a/F1.2b e da verificação F1.3/F2.
- Resultado associado à consulta; histórico imutável; nunca sobrescrever
  validação/credencial antiga.
- Resultado de comparação explícito: `improved`, `unchanged`, `diverged`,
  `inconclusive`.
- Vínculo de substituição (provável coluna aditiva
  `validation.supersedes_validation_id`, decidida só aqui).
- Fluxo inicial (coleta) e de atualização compartilham o mesmo mecanismo, com
  semântica distinta.

### Fora de escopo

- Wallet, OID4VP, autenticação do titular por gov.br (avaliar depois).
- Portal do titular como produto separado.
- Credencial como pré-requisito para o link.

### Critérios de conclusão

- Token não funciona cross-tenant, expirado ou reutilizado.
- Divergência produz resultado explícito e não apaga o histórico.
- Auditoria registra quem pediu, quem respondeu e quando.
- Teste de concorrência no consumo do token.
- Nenhum PII na URL; logs sem conteúdo do documento.

### Riscos

- Vazar PII no link (não colocar documento/endereço na URL).
- Confundir "atualização" com "contestação" (já existe `contest`).
- Autenticação do titular ser fraca e permitir que terceiro envie documento.

### Decisões abertas

- Link é por consulta, validação ou caso? Existe entidade "caso"?
- Quem é o titular: pessoa do `subject` ou quem recebe o link?
- Consentimento é por validação, por consulta ou por finalidade?
- Como o titular se autentica (gov.br, OTP, magic link)?
- Atualização é sempre nova consulta faturável? (ligação com F3)

---

## Fase 5 — Credencial como saída verificável (P2)

**Objetivo:** transformar a camada de credencial já construída em uma **saída
verificável do resultado**, depois do produto comercial. A credencial não é o
centro do MVP nem uma fonte de evidência.

### Estado atual comprovado (já entregue)

- VC 2.0 com `eddsa-jcs-2022` (JCS + Ed25519 + multibase);
- DID `did:web`, documento público, chave por tenant, providers local e AWS KMS;
- rotação, revogação, expiração, status público, reemissão determinística e
  superação no deep path;
- verificador independente (`verifyCredentialIntegrity`,
  `verifyCredentialFromIssuer`, `makeHttpIssuerResolver`);
- testes em `packages/credential` e `apps/api`.

### Lacunas

1. Não há entrega ao titular (nem wallet); a credencial volta na resposta HTTP e
   não há canal estável de recuperação.
2. O status usa endpoint próprio, não um formato padrão de status list.
3. Não há "kit de verificação" para um terceiro verificar sem acesso ao banco.
4. Não está decidido se a credencial é por consulta/validação, por subject ou
   por caso.
5. Não há vínculo de holder (quem é o dono da credencial).

### Escopo

- Definir o papel: recibo verificável para o cliente B2B **ou** credencial do
  titular. São produtos diferentes.
- Kit de verificação: documento + exemplo executável + chaves públicas.
- Decidir formato de status (manter endpoint atual ou adotar status list padrão).
- Semântica de TTL documentada para o cliente (credencial expira antes/depois da
  evidência?).
- Se houver holder: binding explícito e consentimento.
- A credencial é emitida apenas a partir de resultado verificado/policy; nunca
  diretamente do upload.

### Fora de escopo

- OID4VCI, OID4VP, wallet, divulgação seletiva (F8).
- Emissão de credencial a partir de upload sem verificação.
- Substituir a policy/veredito pela credencial.

### Critérios de conclusão

- Um verificador externo (sem banco) consegue validar assinatura, issuer,
  status e expiração seguindo a documentação.
- Revogação propaga e é observável.
- Teste de DID resolution e de chave rotacionada.
- Credencial rejeitada quando o resultado não é terminal/verificado.

### Riscos

- Credencial reutilizável reduz consultas faturáveis — decisão comercial, não
  técnica.
- Status caseiro não interopera com verificadores de mercado.
- Confundir credencial com prova de residência: ela assina um resultado, não a
  verdade do mundo.

### Decisões abertas

- Credencial é o produto ou o recibo?
- Status próprio vs status list padrão.
- Há holder ou só cliente corporativo?
- A credencial é por consulta, subject ou caso?

---

## Fase 6 — Operação e segurança contínua (P2)

**Objetivo:** sustentar produção com múltiplas fontes de evidência e documento de
cliente, sem aumentar risco operacional.

Escopo:

- Runbooks: autorizador/fonte fora do ar, resposta inesperada, vazamento de
  artefato, revogação/rotação de chave, restore, análise travada, fila parada.
- Alarmes: taxa de `unavailable`, latência por fonte, divergência de uso/fatura,
  falha de retenção, duplicidade de análise/claim, atraso da fila.
- Capacidade e custo (storage de artefato, OCR, consultas externas).
- Revisão de acesso: dashboard com API key compartilhada, rotação de pepper,
  escopos, KMS.
- Teste de restore e de revogação em produção.
- Reconciliação periódica storage × banco para artefatos.

Critérios: cada runbook executado em ensaio; alarme dispara em cenário
simulado; restore dentro do RPO/RTO definido.

Decisão aberta crítica: **o dashboard não é multi-tenant por cliente** — usa uma
`VITE_API_KEY` única e `user_id` só particiona stats. Para vender B2B, isso
precisa virar sessão/BFF ou uma chave por tenant, com isolamento real.

---

## Fase 7 — Expansão de fontes: NFAg-e e outras (P3, com gate)

**Gate:** demanda de cliente + fonte/autorizador estável + direito de uso
confirmado + contrato F2 maduro.

### Fatos externos verificados em 2026-10-22

| Fonte              | Fato                                                                                    | Implicação                   |
| ------------------ | --------------------------------------------------------------------------------------- | ---------------------------- |
| NFAg-e (modelo 75) | Publicada como **Minuta**, aguardando ato conjunto normativo definitivo                 | Não prometer disponibilidade |
| Autorizador NFAg   | **Somente SVRS** (produção e homologação)                                               | Sem cobertura nacional       |
| Implantação        | NT 2026.004 em homologação SVRS (19/10/2026); NT 2026.002 em produção SVRS (31/08/2026) | Está ativa, mas restrita     |
| QR NFAg            | `https://dfe-portal.svrs.rs.gov.br/nfag/qrCode`                                         | Mesmo cuidado de allowlist   |

Fontes: [portal NFAg](https://dfe-portal.svrs.rs.gov.br/Nfag),
[Serviços NFAg](https://dfe-portal.svrs.rs.gov.br/Nfag/Servicos). Consultadas em
2026-10-22.

### Escopo

- Adicionar NFAg-e como **mais um adaptador** do contrato F2, sem tocar no
  domínio e sem criar `claim.type` específico.
- Reutilizar allowlist, guarda de fetch, fixtures, estados e taxonomia de F2.
- Adicionar outras fontes (cadastrais, geolocalização/POI, fiscais) somente com
  demanda, direito de uso e contrato estável.
- Declarar explicitamente o que não é suportado; não prometer cobertura
  nacional.
- Testes por autorizador/fonte e documentação de cobertura.

### Fora de escopo

- Cobertura fiscal nacional.
- Nova tabela/domínio por fonte.
- Scraping de portal sem autorização/estabilidade.
- Emissão/assinatura fiscal.

### Critérios de conclusão

- NFAg-e coberta por fixture → outcome correto.
- Nenhuma URL de QR/entrada do usuário vira fetch direto.
- Fonte indisponível → `unknown`, nunca `contradicts`.
- Documentação de cobertura por autorizador/fonte.
- Nenhum `claim.type` especial criado.

### Riscos

- Norma ainda em minuta; não prometer data.
- Cobertura restrita a SVRS.
- Custo de manutenção de múltiplos portais.

### Decisões abertas

- Quais fontes/UF primeiro? (demanda comercial)
- Quais fontes cadastrais/POI têm direito de uso e contrato?
- Cache/TTL por fonte.

---

## Fase 8 — SSI: OID4VCI/VP/wallet (P3, com gate)

**Gate:** um verificador ou holder externo **exigir** o protocolo. Sem isso, o
custo (novos endpoints, superfície de segurança, suporte, interoperabilidade)
não se paga.

O que já existe e deve ser preservado: VC 2.0, DID, prova, status, revogação,
verificador e backend KMS. O que falta é protocolo de emissão/apresentação e
wallet.

Não confundir "SSI" com "credencial":

- a credencial é uma **saída verificável** do resultado (F5);
- SSI/wallet/VP é um **canal de distribuição/apresentação** dessa credencial;
- nenhum dos dois é pré-requisito para vender verificação de endereço.

### Escopo

- OID4VCI para emissão, OID4VP para apresentação e wallet quando houver demanda
  externa comprovada.
- Teste de interoperabilidade com verificador/holder externo.
- Manter o verificador independente e a verificação de assinatura local.
- Não transformar a wallet em fonte de evidência.

### Fora de escopo

- Wallet própria como diferencial de MVP.
- Divulgação seletiva, BBS+, SD-JWT, blockchain, TSA.
- Substituir o fluxo B2B de resultado/credencial por SSI.

### Critérios de conclusão

- Um verificador externo consegue apresentar/validar a credencial via protocolo
  acordado.
- Nenhum dado de evidência vaza no protocolo além do consentido.
- Revogação/expiração continuam funcionando no novo canal.

### Riscos

- Complexidade de protocolo sem demanda.
- Interoperabilidade e suporte.
- Expectativa de que SSI resolve prova de residência; não resolve.

---

## Revisão crítica do que existia

### Manter

| Item                                             | Por quê                                        |
| ------------------------------------------------ | ---------------------------------------------- |
| Camada de credencial (ADRs 0019–0032)            | Entregue, testada, correta; é ativo, não custo |
| `claim → claim_evidence → assessment` (ADR-0016) | Espinha dorsal; evita segundo domínio          |
| Idempotência, RLS, outbox, retenção              | Já resolvem problemas reais                    |
| Fast path T0                                     | É o produto que já funciona e vende            |
| KMS como backend de produção                     | Requisito de segurança; não é SSI              |

### Reordenar

| Item                        | De → Para                                 | Motivo                                                                    |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| SSI/wallet/OID4VCI/VP       | próxima etapa → F8 (P3)                   | Sem demanda comprovada; alto custo; não destrava receita                  |
| Credencial como "o produto" | protagonista → F5 (P2, saída)             | O B2B paga por verificação; credencial reutilizável reduz consulta        |
| NF3e/NFAg-e                 | tipos/fases especiais → adaptadores F2/F7 | Fonte é fonte; não é `claim.type` nem domínio paralelo                    |
| Documento/PDF               | capacidade central → uma Evidence Source  | O comprovante é uma fonte entre várias; parser é detalhe de implementação |
| Deep path/VLM               | prioridade alta → depois de F1/F2         | `VLM_ENABLED=false` por default e depende de chave paga; documento é P1   |
| Roadmap #24 (signing keys)  | aberto → **concluído**                    | 24.1/24.2/24.3 entregues; vira histórico                                  |

### Adiar ou descartar

| Item                          | Decisão                  | Motivo                                                      |
| ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| Cobertura fiscal nacional     | **descartar a premissa** | Só autorizadores confirmados; declarar UF a UF              |
| NFAg-e agora                  | adiar para F7            | Minuta sem ato definitivo; só SVRS                          |
| Wallet própria                | adiar/descartar no MVP   | Não é diferencial                                           |
| Tabela/domínio por fonte      | **não criar**            | O contrato de observação/verificação + `detail` já cobre    |
| SSI como pré-requisito do MVP | **não**                  | Verificação de endereço e resultado B2B são o valor inicial |
| Segundo roadmap               | **não criar**            | Este arquivo é o canônico                                   |

### Adicionar / acompanhar

| Item                                    | Fase    | Estado / por quê                                          |
| --------------------------------------- | ------- | --------------------------------------------------------- |
| Evidence Source / EvidenceObservation   | F1/F2   | Implementado; uniformiza documento e fontes               |
| Contrato de verificador + taxonomia     | F1.3/F2 | Implementado; evita "booleano mágico" e duplicação        |
| Verificação do documento contra o claim | F1.3    | **Entregue**; fecha a etapa de extração                   |
| Policy/scoring por dimensões            | F3      | **Primeiro slice entregue**; evolução por tenant pendente |
| Fluxo comercial e cobrança por consulta | F3      | F3.2 entregue; F3.3 é o próximo passo B2B                 |
| Fluxo do titular por link seguro        | F4      | Futuro; requisito de coleta/atualização                   |
| Credencial como saída                   | F5      | Parcialmente entregue; kit/produto ainda evolui           |
| Guarda de fetch (SSRF real)             | F0      | Entregue; expansão/hardening operacional continua         |
| Medição faturável                       | F3      | Próximo; sem isso não há receita auditável                |
| Expansão de fontes (NFAg-e etc.)        | F7      | Futuro; adaptadores, não novos domínios                   |

## Decisões de produto em aberto

1. **Unidade de cobrança** e o que não é faturável (consulta, validation,
   documento, fonte ou relatório). É a decisão comercial mais importante da F3.
2. **Dashboard multi-tenant**: chave por tenant + sessão/BFF vs continuar
   single-tenant de dev.
3. **Artefato**: por quanto tempo reter o binário no object storage privado (o
   armazenamento já foi decidido no ADR-0035). Hoje a remoção segue a expiração
   da validação; `retention_until` ainda não controla o ciclo de vida do binário.
4. **Policy por cliente**: necessária para o primeiro contrato ou pode ser
   global com contrato de versão?
5. **Credencial**: recibo B2B, credencial do titular ou ambos?
6. **Titular**: como se autentica no link de coleta/atualização?
7. **Fontes iniciais**: quais UFs/fontes externas priorizar por demanda?
8. **Consulta fiscal**: QR público apenas ou SOAP com certificado?
9. **Resultado**: qual nível de detalhe de evidência o cliente B2B recebe sem
   expor PII?
10. **Atualização**: nova consulta faturável ou continuidade da consulta
    original?

## F0.2 — entregue (2026-10-22)

**Guarda de fetch compartilhada, com testes negativos, aplicada ao webhook e
reutilizável pela fonte fiscal.**

Entregue:

- `safeExternalFetch` (`packages/providers/src/safe-fetch.ts`), usando
  `node:https` e `node:dns/promises` (sem novo cliente HTTP) e `ipaddr.js` para
  classificar faixas IPv4/IPv6. Resolve o host, rejeita IP privado/loopback/
  link-local/metadata/reservado, fixa o IP validado no `lookup` da conexão, não
  segue redirect, limita tempo/headers/corpo e valida content-type;
- `isSafeWebhookUrl` continua apenas como validação de UX no cadastro; a entrega
  do webhook usa a guarda no momento do envio;
- testes negativos em `packages/providers/src/safe-fetch.test.ts` e
  `apps/api/tests/modules/webhooks/webhook-safe-fetch.int.test.ts`, incluindo
  DNS rebinding e log sem payload/segredo/assinatura;
- motivo de bloqueio estruturado (`SafeFetchError.reason`) registrado no log do
  webhook e em `webhook_delivery.last_error`. O contador Prometheus por motivo
  fica para a observabilidade contínua (F6); F0.2 entrega o sinal estruturado.

**F0.1 (entregue em 2026-10-22):** `evidence_artifact` tenant-scoped, RLS FORCE,
FK composta, storage de objetos reutilizado, retenção integrada e testes de
isolamento/integridade (ADR-0035; migration 0039).

**F1.1/F1.2 (entregues em 2026-10-22):** intake seguro, análise/extração e
entendimento do comprovante, com `evidence_analysis` append-only e idempotente
(ADR-0037/ADR-0038; migrations 0040/0041). A F1.3 foi entregue em 2026-10-23.

**F2.1/F2.2:** contrato fiscal, referência normalizada, QR físico e primeira
consulta real NF3-e SVRS para RS/SP entregues; cobertura adicional, cache,
métricas e hardening continuam no backlog.

**Próximo passo:** fechar o checklist de produção e implementar a **F3.3**
(evento faturável canônico, cotas, reconciliação e regras de não cobrança).
