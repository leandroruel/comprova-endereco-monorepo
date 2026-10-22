# Arquitetura de evidências e verificação fiscal (alvo)

> **Status:** proposta de arquitetura, 2026-10-22. **F0.1 (artefato
> tenant-scoped) e F1.1 (intake do comprovante) estão implementados**; OCR,
> extração, matching, contrato de verificador e consulta fiscal continuam não
> implementados.
> Este documento descreve o alvo e o que já existe para reaproveitar. As decisões
> estão registradas em [ADR-0033](adr/0033-verificacao-de-evidencias-por-adaptadores.md),
> [ADR-0034](adr/0034-consulta-a-fontes-fiscais-endpoints-oficiais.md),
> [ADR-0035](adr/0035-artefato-de-evidencia-tenant-scoped.md) e
> [ADR-0037](adr/0037-intake-de-comprovante-do-cliente.md).
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
claim_evidence → evidence`. O que falta é um **contrato de verificação** e uma
taxonomia de resultado — não tabelas novas.

## 2. Princípios

1. **Fonte é fonte; evidência é evidência.** O adaptador fala com o mundo e
   devolve um resultado tipado. A persistência continua sendo `claim_evidence`
   (observação) + o material: `evidence` para captura pública e
   `evidence_artifact` para PII tenant-scoped (F0.1).
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

| Responsabilidade      | Hoje                                                             | Alvo                                         |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Entrada de evidência  | HTTP autenticado + storage privado (F1.1); street view no worker | Igual                                        |
| Identificação do tipo | Assinatura de PDF/JPEG/PNG no intake (F1.1)                      | Estrutura/OCR e XML/QR (F1.2/F2)             |
| Extração de campos    | VLM de fachada                                                   | OCR/PDF no intake; parse no adaptador fiscal |
| Consulta externa      | Providers de endereço com URL fixa                               | Adaptadores com allowlist (F2)               |
| Normalização          | Checkers T0/T1/T2                                                | Normalizador por fonte                       |
| Persistência          | `claim_evidence` + `evidence`/`evidence_artifact` (F0.1/F1.1)    | Igual + evidência de fonte fiscal (F2)       |
| Avaliação             | `evaluateClaim` / `weightedScore`                                | Igual + metadados de independência           |
| Explicação            | `assessment` / `explanation_detail`                              | Igual                                        |
| Credencial            | `@comprova/credential`                                           | Igual (credencial é saída, não evidência)    |

## 4. Contrato conceitual do verificador

> Esboço de contrato. **Não implementar nesta tarefa.** A forma exata (nomes,
> módulo, assinatura) é decidida na F2, com o adaptador NF3e como primeira
> implementação.

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

### 4.3 Uma observação por fonte

Recomendação: **uma linha em `claim_evidence` por consulta a uma fonte**, com as
três dimensões no `detail` (jsonb). Não criar três linhas (autenticidade,
endereço, titular) porque:

- as três vêm da mesma fonte e não são independentes; somá-las no score é
  contar a mesma prova três vezes;
- `claim_evidence` é imutável e auditável por linha;
- o peso por checker já existe em `policies/*.yaml` (`weights`).

Se um dia for necessário ponderar endereço e titular separadamente, isso é uma
mudança de **scoring** (`SCORER_VERSION`), não de schema.

## 5. Modelo de dados: reuse primeiro

| Necessidade                 | Onde cabe hoje                                                       | Extensão mínima                            |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Tipo de documento           | `evidence.kind` + `claim_evidence.detail`                            | Vocabulário controlado (sem migração)      |
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
`detail` jsonb é o lugar de evolução; ele já é usado pelos checkers.

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
Artifact (bruto) → Evidence (observação) → Assessment (avaliação) → Credential (assinada)
```

`artifact` não é `credential`: o primeiro é matéria-prima com retenção curta; a
segunda é a saída verificável da avaliação.

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
  verificação, não negação do documento. Não há score nem afirmação de
  endereço/titular enquanto F1.2/F1.3 não rodarem.
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

O `GET /v1/validations/:id` existente reflete a observação em
`evidence_summary.unknown`. Detalhe do documento e resultado de verificação
continuam fora do payload até a extração de F1.2.

## 6. Segurança das consultas externas

A guarda genérica `safeExternalFetch` foi entregue em F0.2 (ADR-0036) e já é
usada no envio de webhook. Ela cobre resolução/fixação de IP, HTTPS, ausência de
redirect e limites de tempo/corpo/content-type. Para fonte fiscal ainda falta a
**allowlist por autorizador** e o adaptador (ADR-0034). Requisitos:

1. **Allowlist server-side** por `(tipo de documento, autorizador, ambiente)`.
   A URL do QR é usada apenas para **identificar** o autorizador — nunca para
   fetch. **Ainda não implementado (F2).**
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
   por política do caller fiscal, que ainda será implementado em F2.
6. **Auditoria:** gravar IP resolvido (`SafeFetchResponse.address`), status HTTP
   e sha256 da resposta, não a resposta inteira em log. **O IP/status são
   expostos pela guarda;** o hash e a URL ficam para o caller fiscal (F2).
7. **Rate limit** por tenant e por fonte, além do cache por chave. **Ainda não
   implementado (F2).**

`isSafeWebhookUrl` continua apenas no cadastro como validação de UX; ela não
resolve DNS e não substitui a guarda no envio.

Testes obrigatórios já cobertos para a guarda: host privado literal, host que
resolve para privado, redirect para privado/HTTP/outro host, corpo grande,
content-type inesperado, timeout e rebinding. A URL de QR fora da allowlist será
testada em F2.

## 7. Confiança, atualidade e divergência

| Dimensão               | Campo hoje                                                                          | Semântica                             |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| Quando foi observado   | `claim_evidence.observed_at`                                                        | Momento da coleta (consulta/extração) |
| Validade da evidência  | `claim_evidence.ttl_seconds` + `decayOf`                                            | Quanto o sinal decai no score         |
| Validade do artefato   | `evidence_artifact.retention_until` (cliente) / `evidence.retention_until` (legado) | Quanto o binário é retido (LGPD)      |
| Emissão do documento   | `detail.issued_at` (proposto)                                                       | Competência do comprovante            |
| Retenção da validação  | `validation.expires_at`                                                             | 30 dias hoje, hardcoded               |
| Validade da credencial | `validFrom` / `validUntil`                                                          | Derivada do completion + TTL          |

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

| Necessidade                 | Mudança mínima                                     | Quando |
| --------------------------- | -------------------------------------------------- | ------ |
| Escopo tenant de PII        | `evidence_artifact` (entregue em F0.1)             | F0.1   |
| Guarda de fetch             | Módulo único testado, reusado por webhook e fiscal | F0     |
| Contrato de verificador     | Módulo puro + tipos + testes                       | F2     |
| Allowlist de autorizadores  | Tabela versionada em código                        | F2     |
| Evento faturável            | `usage_event` com unique/idempotência              | F3     |
| Supersessão                 | `validation.supersedes_validation_id`              | F4     |
| Status padrão de credencial | Decisão; sem migração até decidir                  | F5     |
| Policy por cliente          | Decisão; sem schema até decidir                    | F3/F5  |

Nenhuma dessas mudanças é pré-requisito para as outras fases além do indicado.
**Não implementar todas de uma vez.**

## 11. Decisões abertas

1. ~~`evidence` com `tenant_id` ou `evidence_artifact` separado?~~ **Decidido:
   `evidence_artifact` tenant-scoped (ADR-0035).**
2. ~~Reter binário ou hash + campos?~~ **Decidido na fundação: objeto no storage
   privado + metadados; prazo comercial de retenção permanece aberto.**
3. Uma observação por fonte ou por dimensão? (recomendado: por fonte)
4. NF3e por QR público ou SOAP com certificado? (F2)
5. UFs iniciais? (F2)
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
- [NF3e — FAQ SVRS](https://dfe-portal.svrs.rs.gov.br/Nf3e/Faq)
- [NF3e — Serviços SVRS](https://dfe-portal.svrs.rs.gov.br/Nf3e/Servicos)
- [NFAg — portal SVRS](https://dfe-portal.svrs.rs.gov.br/Nfag)
- [NFAg — Serviços SVRS](https://dfe-portal.svrs.rs.gov.br/Nfag/Servicos)
