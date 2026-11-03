# ADR-0043: Integração do Marker (Document Intelligence) na análise de documento (F1.2)

## Status

Aceito (2026-11-02). Emenda o
[ADR-0038](0038-analise-de-documento-do-cliente.md) e o
[ADR-0039](0039-extracao-de-pdf-com-unpdf.md). Não cria etapa nova nem altera o
roadmap.

Relaciona-se com o [ADR-0035](0035-artefato-de-evidencia-tenant-scoped.md)
(artefato de PII), [ADR-0036](0036-guarda-de-fetch-externo.md) (guarda de fetch
externo) e [ADR-0033](0033-verificacao-de-evidencias-por-adaptadores.md)
(contrato do verificador).

## Contexto

O serviço `apps/document-intelligence` (FastAPI + Marker 2.x) já existia e
estava operacional, com um cliente HTTP consumido apenas pela rota
`POST /v1/documents/parse` da API. O worker, porém, analisava apenas a camada
textual do PDF via `unpdf` (ADR-0039) e o extrator determinístico de
QR/referência fiscal. Consequências:

- PDFs **escaneados** (sem camada textual) terminavam em `inconclusive` /
  `NO_TEXT_LAYER`, sem OCR — os campos de titular/endereço não eram extraídos;
- campos que o Marker entrega como **tabela/bloco** não eram considerados;
- o cliente HTTP vivia em `apps/api`, inacessível ao worker sem duplicação.

O objetivo desta decisão é integrar o Marker **ao pipeline existente**, sem
criar arquitetura paralela, sem remover o `unpdf`, sem substituir o extrator de
QR e sem introduzir LLM/VLM/RAG nem chamadas externas novas.

## Decisão

### 1. Reuso do cliente HTTP em `@comprova/providers`

O cliente do Document Intelligence (`makeDocumentIntelligenceClient`) foi movido
de `apps/api/src/services/` para
`packages/providers/src/document-intelligence/`. A API passa a importá-lo de
`@comprova/providers`; o worker o instancia com o mesmo contrato. Não há
duplicação de rede nem dependência circular (`@comprova/contracts` só depende de
`zod`; `@comprova/observability`, de `pino`/`prom-client`).

### 2. Adapter `marker.ts`

`makeMarkerAdapter(client)` encapsula o cliente e:

- valida a resposta com `DocumentIntelligenceResponseSchema` (fonte de verdade
  em `@comprova/contracts`) — nunca confia no payload cru;
- mapeia falhas para códigos estáveis: `not_configured`, `timeout`,
  `unavailable`, `busy`, `unsupported`, `no_text`, `parsing_failed`, `partial`;
- extrai texto ordenado de leitura e coleta as tabelas dos elementos;
- emite trace (`marker.call`, `marker.success`, `marker.error`, `marker.no_text`).

O adapter **não** decide autenticidade, correspondência de endereço nem
validade. Ele só fornece texto/layout.

### 3. Política de fallback explícita (`analyze.ts`)

A seleção da fonte textual é determinística e observável:

1. **Camada local suficiente** (`unpdf`, ≥ 8 caracteres): usar o texto local e
   **não** chamar o Marker. Registra `provenance.provider = 'local'` apenas
   quando o Document Intelligence está configurado.
2. **Camada local insuficiente + Marker configurado**: chamar o Marker. Em
   sucesso, usar o texto do Marker (`provider = 'marker'`). Em falha, cair para
   o texto local mesmo insuficiente, com `provenance.fallback = true` e código
   `MARKER_<KIND>` adicional a `NO_TEXT_LAYER`.
3. **Camada local insuficiente + Marker ausente**: manter o comportamento do
   contrato anterior (`NO_TEXT_LAYER`), sem proveniência.

Códigos diferenciados: indisponível (`MARKER_UNAVAILABLE`), timeout
(`MARKER_TIMEOUT`), não suportado (`MARKER_UNSUPPORTED`), sem texto
(`MARKER_NO_TEXT`), falha de parsing (`MARKER_PARSING_FAILED`) e OCR sem
resultado utilizável (`OCR_NO_USABLE_TEXT`). Nenhum fallback transforma falha de
OCR em conclusão silenciosa.

### 4. Extração estruturada (`structured.ts`)

`extractTableCandidates` converte células de tabela do Marker em candidatos
`rótulo: valor` (conjunto genérico de rótulos, sem regra por distribuidora).
`addressFromTableCandidates`/`holderFromTableCandidates` só completam campos que
o texto deixou ausentes; rótulos repetidos com valores divergentes são
ambíguos (resultado `null`), e o endereço de correspondência não é confundido
com o de fornecimento.

### 5. QR e referência fiscal inalterados

O caminho determinístico de QR/referência (`fiscal/reference.ts`) **não** passa
pelo OCR. O texto do Marker não alimenta a referência fiscal, não substitui o QR
e não é prova de autenticidade. A ordem (texto → QR → combinação compatível)
permanece.

### 6. Contrato e persistência (mudança aditiva)

`DocumentAnalysisResult` ganha o campo **opcional** `provenance`
(`provider: 'local' | 'marker'`, `markerVersion?`, `pages?`,
`processingTimeMs?`, `fallback?`). Bump: contrato `3 → 4`, analyzer
`1.2.0 → 1.3.0`; `DOCUMENT_ANALYZER_ID` continua `text_document`.

A tabela `evidence_analysis` continua append-only e indexada por
(`artifact_id`, `analyzer`, `analyzer_version`, `contract_version`). Linhas
`pending` antigas (contrato 3) deixam de ser consumidas — consequência já
documentada no ADR-0039. `provenance` não contém PII, conteúdo integral, base64
nem URL fiscal.

### 7. Wiring

O worker recebe `DOCUMENT_INTELLIGENCE_URL`, `DOCUMENT_INTELLIGENCE_TIMEOUT_MS`
e `DOCUMENT_INTELLIGENCE_MAX_FILE_SIZE_MB` (mesmos nomes da API). Sem URL, o
cliente fica desabilitado e o analyzer opera como antes. O debugger
`POST /v1/debug/nf3e/qrcode` usa o **mesmo** analyzer com o cliente real e expõe
`provenance`.

## Consequências

- PDFs escaneados passam a produzir campos via OCR do Marker, com a limitação e
  o código de erro registrados quando o OCR não é utilizável.
- O caminho textual local permanece preferencial e barato; o Marker só é
  acionado quando necessário.
- O volume de dados persistidos cresce apenas com `provenance` (poucos bytes);
  nenhum payload bruto do Marker é gravado.
- Bumps de contrato/analyzer tornam linhas `pending` antigas órfãs (aceito).
- O Marker nunca decide autenticidade; `evidence_verification` e o assessment
  permanecem inalterados.

## Alternativas rejeitadas

1. **Sempre chamar o Marker.** Rejeitado: custo/latência desnecessários em PDFs
   textuais e mais exposição de PII a um serviço externo.
2. **Substituir o extrator de QR pelo OCR.** Rejeitado: o QR é o artefato
   canônico do emitente; OCR não é prova de autenticidade.
3. **Criar um segundo analyzer/loop paralelo.** Rejeitado: contrato duplicado,
   consumidores divergentes.
4. **Gravar o JSON bruto do Marker.** Rejeitado: PII, base64 de imagem e volume;
   só metadados mínimos de proveniência são persistidos.
5. **Introduzir VLM/RAG nesta etapa.** Rejeitado: fora de escopo e sem contrato
   de verificação correspondente.
