# ADR-0041: Contrato FiscalAdapter e materialização da observação fiscal (F2.1)

## Status

Aceito (2026-10-23). Implementa o **contrato** de fonte fiscal e a
materialização da observação em `claim_evidence`, **sem nenhuma consulta real a
autorizador**. A execução NF3e (allowlist preenchida, fetch, parsing e
credenciais, se necessárias) fica para F2.2b; a F2.2a entrega apenas a
extração/normalização da referência, sem rede. Emendado em 2026-10-24 pela
parte física da F2.2b: a decodificação local do QR foi entregue. Emendado em
2026-10-25 pela primeira fatia de consulta real: **NF3e/SVRS, UF RS, ambiente
produção**, sem cobertura nacional.

Relaciona-se com o [ADR-0033](0033-verificacao-de-evidencias-por-adaptadores.md)
(verificador e taxonomia), [ADR-0034](0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
(consulta apenas por endpoint oficial resolvido no servidor),
[ADR-0035](0035-artefato-de-evidencia-tenant-scoped.md) (artefato de PII),
[ADR-0036](0036-guarda-de-fetch-externo.md) (guarda única de fetch) e
[ADR-0040](0040-verificacao-do-documento-enviado.md) (observação sem `signal`).

## Contexto

A F1.3 materializou a verificação do documento **enviado** como uma observação
sem `signal`, mas ela não autentica o documento: não há consulta a autorizador
fiscal nem validação criptográfica. A F2 é a etapa em que uma fonte oficial pode
afirmar que o documento existe/é válido.

Antes de ligar a NF3e, era preciso resolver cinco riscos:

1. **SSRF:** o QR é controlado pelo usuário e pode apontar para qualquer host.
2. **Score:** uma fonte oficial não pode decidir `approved`/`rejected` nem
   inventar `trust_score`; isso pertence à policy/assessment.
3. **Taxonomia:** não criar um segundo vocabulário de status ao lado do
   verificador existente.
4. **Dados:** não persistir a resposta fiscal bruta nem PII desnecessária.
5. **Operação:** replay/retry não pode duplicar observação; nova versão do
   adapter não pode apagar a anterior; tenant não pode vazar.

## Decisão

### 1. Adapter pequeno, puro e independente de infraestrutura

`packages/core/src/fiscal-verification.ts` define:

```ts
interface FiscalAdapter {
  readonly source: FiscalSourceId // 'nf3e' | 'nfag-e'
  readonly version: string
  supports(input: FiscalLookupInput): boolean
  verify(input: FiscalLookupInput, context: FiscalAdapterContext): Promise<FiscalVerificationResult>
}
```

- `FiscalLookupInput` carrega `source`, `tenantId`, `claimId`, `documentId`,
  `qrCodeUrl`, `issuer`, `uf` e `artifact`.
- **Não há endpoint, credencial HTTP, cookie ou função de fetch no contrato.**
- `FiscalAdapterContext` leva o tenant, o endereço/titular de comparação e um
  `now()` injetado. O adapter concreto é quem resolve o endpoint server-side e
  usa a guarda existente; isso não vaza para o contrato de domínio.

### 2. Reutilizar a taxonomia existente: `authentic` é o “verified”

O resultado separa:

```text
document: authentic | not_found | invalid | inconclusive | unavailable | unsupported
address:  matches | differs | not_extracted
holder:   matches | differs | not_extracted
```

`authentic` é o estado **verified** da taxonomia já definida no ADR-0033. Não
foi criado um valor `verified` paralelo. `unavailable`/`inconclusive`/
`unsupported` nunca são convertidos em `invalid`; timeout da fonte é
`unavailable`.

### 3. O adapter não pontua e a observação não altera o score

A materialização grava **uma** linha em `claim_evidence`:

- `source = 'fiscal_nf3e' | 'fiscal_nfag'`;
- `checker = 'nf3e_verification' | 'nfag-e_verification'`;
- `stance` calculado por `stanceForDimensions` (política compartilhada com a
  F1.3);
- `strength = 0`, `confidence = 0`;
- **sem `signal`**.

Assim, o `weightedScore` e o veredito continuam inalterados. A F3 decide peso,
força e eventual hard rule da fonte fiscal. O schema de saída
(`fiscalVerificationResultSchema`) é `strip`: campos como `trust_score`,
`final_score`, `approved` ou `rejected` não chegam ao banco.

### 4. Identificadores de fonte

`nf3e` e `nfag-e` existem no contrato. A primeira fatia real implementa apenas
`nf3e`/SVRS/RS/produção; o adaptador **fake** NF3e continua sendo usado nos
testes de contrato. NFAg-e, outros autorizadores e outras UFs continuam fora.
A F2.2a adiciona `FiscalReference` e `extractFiscalReference` para classificar
uma referência já extraída, sem rede.

### 5. QR não confiável, allowlist server-side e `safeExternalFetch`

O QR é usado apenas para **identificar** a fonte/autorizador. O endpoint de
consulta vem de `packages/providers/src/fiscal/endpoint.ts`, uma allowlist
server-side indexada por `(source, issuer, environment)`, que nesta fatia
contém somente `(nf3e, SVRS, production)`.

A função `safeFetchFiscalEndpoint` não aceita URL de entrada: ela resolve a URL
na allowlist e delega para `safeExternalFetch` (ADR-0036), que aplica HTTPS,
resolução/fixação de IP, bloqueio de loopback/RFC1918/link-local/metadata,
recusa de redirect e limites de tempo/corpo/content-type. Uma allowlist mal
configurada para metadata/RFC1918 ainda é barrada pela guarda.

### 6. Sem resposta bruta e com minimização de PII

O `detail.verification` guarda apenas:

- as três dimensões e o status normalizado;
- `source`, `method`, `environment`, `issuer`;
- `document_ref_hash` (nunca a chave de acesso/URL do QR);
- versão do adapter/contrato, `observed_at`, `issued_at`;
- limitações/códigos;
- auditoria mínima: IP resolvido, status HTTP, hash do corpo e hash da URL
  pedida.

Não são persistidos corpo, headers, cookies, URL crua ou a chave de acesso. Logs
usam ids internos, status e reason codes, nunca URL/documento/PII.

### 7. Idempotência e versionamento

A chave natural é `(claim_id, source, checker, checker_version)`.
`checker_version` combina:

```text
<adapter_version>+a<adapter_source>+d<document_ref_hash>+c<contract_version>[+o<transient_outcome>]
```

O adapter de origem entra na chave porque um adapter de outra fonte pode
responder `unsupported` (por exemplo, o adapter NF3e consultado para um input
NFAg-e). O discriminador `+o<transient_outcome>` só aparece para resultados não
terminais (`unavailable`, `inconclusive`, `unsupported`); `authentic`,
`not_found` e `invalid` usam a chave estável. Assim uma tentativa transitória
não ocupa a chave que um resultado terminal posterior precisa.

Consequências:

- replay/retry da mesma consulta não duplica;
- `unavailable` seguido de `authentic` materializa as duas observações, sem
  descartar o resultado terminal como duplicata;
- dois documentos diferentes no mesmo claim não colidem;
- uma nova versão do adapter cria outra linha e preserva a anterior;
- a versão do contrato entra na chave, então mudanças de interpretação também
  preservam histórico.

### 8. Tenant e retenção

Leitura de claim/validation/endereço/titular e escrita da observação usam
`withTenant`/RLS. Input de um tenant apontando para claim de outro retorna
`skipped` e não materializa. A retenção reaproveita `validation.expires_at` e o
`ttl_seconds` existente; não foi inventada uma nova política.

### 9. Fake adapter para o pipeline

`makeFakeFiscalAdapter` é determinístico, sem I/O e configurável por teste. Ele
existe para provar o caminho:

```text
FiscalLookupInput -> FiscalAdapter -> FiscalVerificationResult
  -> claim_evidence (detail.verification)
```

Não é um mock sofisticado nem uma implementação parcial de NF3e.

## Alternativas consideradas

- **Criar `fiscal_verification` como nova tabela de evidência.** Rejeitado:
  duplicaria o modelo de `claim_evidence` e a política de assessment.
- **Deixar o adapter emitir score/veredito.** Rejeitado pelo ADR-0033 e pelo
  princípio de separação observação/policy.
- **Usar a URL do QR diretamente no fetch.** Rejeitado por SSRF; a allowlist
  server-side é obrigatória.
- **Persistir a resposta bruta “para auditoria”.** Rejeitado por minimização;
  hash + campos selecionados bastam para o contrato atual.
- **Uma linha por claim/fonte, sobrescrevendo versões.** Rejeitado:
  `claim_evidence` é imutável e o histórico precisa sobreviver a upgrades do
  adapter.

## Consequências

Positivas:

- A F2.2 implementou a NF3e sem refazer o modelo de evidência.
- O score e o veredito continuam sob controle da policy.
- SSRF, tenant, idempotência e versionamento têm testes cobrindo também a
  primeira chamada real.
- O `GET` atual continua lendo apenas `uploaded_document`; nada muda para o
  cliente.

Negativas / débito consciente:

- A allowlist cobre apenas SVRS/RS/produção; outros autorizadores, UFs e
  ambientes não funcionam.
- O detalhe fiscal não é exposto no `GET` nesta etapa.
- O `FakeFiscalAdapter` não valida parsing nem assinatura. O adapter real foi
  validado com fixtures e sondagem do portal, não com uma chave de produção que
  exponha endereço/titular completos.
- Rate limit, cache por fonte, métricas e descoberta de autorizador ficam para
  etapas posteriores.

## Testes

- `packages/core/src/fiscal-verification.test.ts`: taxonomia, mapeamento de
  fonte, fingerprint, versão do checker, stance conservadora e construtores
  neutros.
- `packages/providers/src/fiscal/fiscal.test.ts`: fake adapter, schema que
  remove scoring, allowlist exata, endpoint fora da allowlist sem fetch e defesa
  de metadata/RFC1918.
- `packages/providers/src/fiscal/nf3e-fiscal-adapter.test.ts`: escopo
  SVRS/RS, allowlist, POST de formulário, timeout/HTTP/content-type/oversized,
  found/not_found/invalid/inconclusive, ausência de PII/scoring e reuso de
  `compareAddress`/`compareHolder`.
- `apps/api/tests/fiscal-verification.int.test.ts`: todos os status, endereço e
  titular independentes, ausência de `signal`, remoção de scoring, timeout como
  `unavailable`, idempotência, versionamento, cross-tenant e a consulta real
  SVRS/RS com servidor local determinístico.

## Emenda F2.2b — parte física (2026-10-24)

A parte física da F2.2b foi implementada sem consulta real. Decisões que
complementam esta ADR:

- O contrato `FiscalReference` subiu para `2` e ganhou o status `inconclusive`
  (QR ilegível, decoder indisponível, PDF não inspecionável) e reason codes
  físicos. `unsupported` continua para conteúdo reconhecido mas não suportado;
  `not_found` só para ausência determinística.
- `extractFiscalReferenceFromArtifact` decodifica PNG/JPEG e imagens raster
  embutidas em PDF com `zxing-wasm`, carregando o WASM apenas do pacote local
  (`wasmBinary`). Não há fetch, DNS, redirect nem CDN; a URL do QR continua
  apenas uma referência não confiável.
- PDF vetorial/desenhado não é renderizado (`PDF_QR_VECTOR_UNSUPPORTED`); não há
  canvas nativo. A extração reaproveita o mesmo `PDFDocumentProxy` da análise de
  texto. PDF com raster inspecionado sem QR também é
  `inconclusive`/`PDF_QR_VECTOR_UNSUPPORTED`: `not_found` fica reservado a
  artefatos integralmente inspecionáveis (PNG/JPEG). O limite de páginas é
  validado antes de qualquer decodificação de QR ou extração de texto.
- Múltiplos QR: mesmo fingerprint vira `found`; referências fiscais distintas
  viram `AMBIGUOUS_REFERENCE`; fiscal + não fiscal vira `found` com
  `MULTIPLE_QR_CODES`. O decoder nunca escolhe arbitrariamente o primeiro. Ele
  lê `maxSymbols + 1` apenas para detectar truncamento; exatamente `maxSymbols`
  referências legíveis ainda passam pela política.
- `DocumentAnalysisResult` subiu para o contrato `3` e o analyzer para
  `text_document@1.2.0`; ambos carregam `fiscalReference`. A URL é removida
  (`url = null`) antes da persistência em `evidence_analysis.result`; o
  `fingerprint` e o `documentId` permanecem para auditoria/consulta futura. O
  fingerprint inclui a URL normalizada e é preservado na redaction, portanto
  não é recalculável a partir da projeção persistida; `documentId` é o
  identificador fiscal estável e a URL é dado transitório.
- Esta parte física não consulta a rede. A consulta real foi entregue na
  emenda seguinte, restrita a SVRS/RS/produção.

## Emenda F2.2b — primeira consulta real (SVRS/RS/produção) (2026-10-25)

A primeira fatia de consulta real fica deliberadamente restrita a **um
autorizador, uma UF e um ambiente**:

- autorizador: SVRS;
- UF: RS;
- ambiente no default da allowlist: produção;
- protocolo: formulário público de consulta por QR da NF3e.

O endpoint é `https://dfe-portal.svrs.rs.gov.br/nf3e/qrCode`
(`NF3E_SVRS_PRODUCTION_QR_ENDPOINT`), o formulário público de consulta por QR
do portal SVRS. A decisão veio do próprio QR oficial
(`.../nf3e/qrCode?chNF3e=<44 dígitos>&tpAmb=<1|2>`) e de sondagem manual do
endpoint. A URL é fixa no código; não há descoberta automática, fallback para o
host do QR nem endpoint vindo do cliente.

O adapter `makeNf3eFiscalAdapter`
(`packages/providers/src/fiscal/nf3e-fiscal-adapter.ts`):

- só suporta `source=nf3e`, `issuer=SVRS`, `uf=RS`, chave de 44 dígitos com cUF
  `43` e modelo `66`, e QR SVRS ou ausente;
- resolve `(nf3e, SVRS, production)` na allowlist e chama
  `safeFetchFiscalEndpoint` → `safeExternalFetch` (ADR-0036);
- envia POST `application/x-www-form-urlencoded` com `pesq.Sistema=Nf3e`,
  `pesq.tpAmb` vindo do ambiente server-side e a mesma chave em `pesq.chBpe`,
  `pesq.chCte` e `pesq.chMdfe`, campos do formulário público observado;
- limita a 5 s, 128 KiB e `content-type: text/html`;
- parseia apenas a seção `destinatario` e reutiliza
  `compareAddress`/`compareHolder`; não parseia emitente, eventos ou
  cancelamento;
- mapeia HTML encontrado → `authentic`; `205` → `not_found`; `201`–`204` →
  `invalid`; 200 não reconhecido → `inconclusive`/`ADAPTER_ERROR`; não-200,
  falha de fetch ou endpoint fora da allowlist → `unavailable`. Timeout vira
  `SEFAZ_TIMEOUT`; nunca `invalid`.

Limitações observadas e débito consciente:

- a resposta pública testada em homologação expõe apenas `Município` no
  destinatário; endereço e titular ficam `not_extracted` na prática;
- a fixture com endereço/titular completos é **sintética** e só prova o caminho
  de comparação caso o portal passe a expor esses campos;
- não foi localizada chave de produção com endereço/titular completos;
- o formulário é uma interface humana observada, não uma API máquina
  formalmente especificada; mudanças no HTML podem virar `inconclusive`
  (`ADAPTER_ERROR`), nunca `invalid`;
- não há cache, rate limit por fonte, métrica nova, circuit breaker, scheduler
  novo, descoberta de autorizador nem NFAg-e.

## Fora de escopo desta etapa

A consulta real foi implementada **somente** para SVRS/RS/produção. Outros
autorizadores, outras UFs, outros ambientes, HTTP/SOAP genérico, certificado
digital genérico, descoberta de autorizador, cache/rate limit por fonte,
exposição do detalhe fiscal no `GET`, NFAg-e, OCR/VLM, wallet/SSI e billing
continuam fora. A **F2.2a** (implementada) entrega apenas a
extração/normalização da referência (payload de QR, URL, chave ou texto) e a
conversão para `FiscalLookupInput`, sem rede; a **parte física da F2.2b**
(implementada) entrega a decodificação local do QR, também sem rede.

## Referências

- [ADR-0033 — Verificação por adaptadores](0033-verificacao-de-evidencias-por-adaptadores.md)
- [ADR-0034 — Consulta a fontes fiscais por endpoints oficiais](0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
- [ADR-0036 — Guarda de fetch externo](0036-guarda-de-fetch-externo.md)
- [ADR-0040 — Verificação do documento enviado](0040-verificacao-do-documento-enviado.md)
- [`docs/arquitetura-evidencias.md`](../arquitetura-evidencias.md)
