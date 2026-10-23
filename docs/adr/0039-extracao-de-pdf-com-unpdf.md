# ADR-0039: Extração de texto de PDF com biblioteca especializada

## Status

Aceito (2026-10-23). Emenda o [ADR-0038](0038-analise-de-documento-do-cliente.md).
Não altera o roadmap nem cria etapa nova.

## Contexto

A primeira versão da F1.2 mantinha um parser PDF próprio em
`packages/providers/src/pdf-text.ts` para lidar com objetos, streams,
`FlateDecode`, operadores `Tj`/`TJ`, strings literais/hex e reconstrução parcial
de camada textual. Esse código não é diferencial do Comprova:

- parsing de PDF é um problema commodity, grande e hostil;
- o subconjunto implementado não cobria fontes CID/Type0, `ToUnicode`,
  encoding, layouts reais nem PDFs escaneados;
- cada correção de parser aumentava a superfície de segurança e a manutenção
  sem melhorar o contrato de evidência;
- o domínio do Comprova é o **contrato, a orquestração, a persistência, o
  isolamento por tenant, a idempotência e a auditoria**, não a leitura de bytes
  PDF.

A pergunta desta decisão é só uma: **quem faz o parsing do PDF?** A extração de
campos, a classificação de documento e a verificação continuam no Comprova.

## Decisão

### 1. Biblioteca

Usar `unpdf@1.9.1` para extrair texto de PDF em Node:

- licença MIT;
- requer Node `>=22` (o repositório usa Node 24);
- empacota o PDF.js e funciona server-side sem canvas para extração de texto;
- API TypeScript para `getDocumentProxy` e `extractText`;
- uma única dependência direta, ~2,2 MB descompactada;
- `pnpm why unpdf` mostra que ela não é usada por outro pacote do monorepo.

O Comprova chama a biblioteca em `document-analyzer/analyze.ts` e mantém o
`DocumentAnalyzer` como fronteira. Não existe `@comprova/pdf-*` nem parser
interno novo: a biblioteca possui o parsing; o Comprova possui o contrato.

### 2. Limites de orquestração

O analyzer continua responsável por impedir consumo descontrolado:

- o intake já limita o tamanho do artefato antes do worker;
- no máximo **50 páginas** por documento (`TOO_MANY_PAGES`);
- no máximo **1.000.000 caracteres** de texto (`TEXT_TOO_LONG`);
- PDF criptografado retorna `unsupported`/`PDF_ENCRYPTED`;
- PDF estruturalmente inválido retorna `inconclusive`/`invalid` com
  `PDF_INVALID`;
- falha de extração em documento abrível retorna
  `inconclusive`/`PDF_TEXT_EXTRACTION_FAILED`;
- texto vazio/curto retorna `inconclusive`/`NO_TEXT_LAYER`;
- o documento é destruído no `finally` (`loadingTask.destroy()`).

Esses limites são política de execução, não parsing. Nenhum deles tenta
reconstruir a camada textual “no braço”.

### 3. Extração de campos conservadora

A biblioteca entrega texto; o Comprova só mapeia **rótulos explícitos** no
formato `Rótulo: valor`:

- endereço: `Endereço`/`Logradouro`, `Número`, `Complemento`, `Bairro`,
  `Cidade`/`Município`, `UF`/`Estado` e `CEP`;
- titular: `Titular`, `Nome do titular`, `Nome`, `Cliente` ou `Razão social`;
- data: `Emissão`, `Data de emissão` ou `Competência`, somente com data completa
  (`DD/MM/AAAA` ou `AAAA-MM-DD`).

Se o rótulo não existe, se repete com valores diferentes ou se o valor é
inválido, o campo fica `null` e o resultado é `not_extracted`. Não há varredura
de texto livre, lista de concessionárias, inferência de competência a partir de
mês/ano nem extração/persistência de CPF/CNPJ. `kind` permanece `unknown`;
adaptadores de fonte fiscal poderão preencher uma classificação confiável no
futuro.

### 4. Contrato

`DocumentAnalysisResult` continua separando `document`, `address` e `holder` e
continua sem `authentic`, `matches` ou `differs`. A mudança de contrato desta
emenda é a remoção de `ExtractedHolder.taxId`/`taxIdType` e o bump para
`contractVersion = '2'` / analyzer `1.1.0`, justificado pela minimização de PII
no F1.2. A verificação F1.3/F2 decidirá se e como precisa do identificador
fiscal; o artefato original continua disponível para uma extração futura
autorizada.

## Alternativas rejeitadas

1. **Manter e “melhorar” o parser próprio.** Rejeitado: parsing commodity,
   cobertura incompleta, mais superfície e manutenção sem ganho de contrato.
2. **`pdfjs-dist` direto.** Rejeitado nesta etapa: ~34,9 MB descompactado e
   configuração de worker/ambiente que o `unpdf` já resolve para Node. A licença
   Apache-2.0 seria compatível, mas o custo operacional é maior.
3. **Poppler/MuPDF nativo.** Rejeitado: dependência de binário/empacotamento,
   licença (MuPDF é AGPL/comercial) e operação em worker Node.
4. **Serviço externo de parsing/OCR.** Rejeitado no F1.2: enviaria PII para
   fora e adicionaria custo/variabilidade antes de existir contrato de
   verificação.
5. **Criar uma biblioteca interna `@comprova/pdf-*`.** Rejeitado: apenas
   esconderia o mesmo código artesanal e redistribuiria a complexidade.

## Consequências

- `packages/providers/src/pdf-text.ts` foi removido; a dependência nova é
  `unpdf`.
- O comportamento para PDFs reais melhora (streams, fontes, encoding e
  compressão ficam com o PDF.js), mas não há OCR: JPEG/PNG continuam
  `unsupported`/`OCR_NOT_IMPLEMENTED`.
- PDFs com fontes sem `ToUnicode`, layout não textual ou encoding quebrado
  podem produzir texto vazio/ilegível; o resultado é `inconclusive` ou campos
  `null`, nunca uma inferência.
- A versão anterior da análise permanece append-only. Linhas `pending` de uma
  versão antiga exigem worker/backfill da versão correspondente; não há
  reescrita nem migração de resultado.
- Testes passam a validar o contrato com PDFs válidos de fixture, não detalhes
  do parser. A escolha da biblioteca fica registrada aqui e no
  `pnpm why unpdf`.
