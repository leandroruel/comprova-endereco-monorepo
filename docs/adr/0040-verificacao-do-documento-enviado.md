# ADR-0040: Verificação do documento enviado (F1.3)

## Status

Aceito (2026-10-23). Implementa a etapa de **verificação** do documento
enviado, entre a análise F1.2 e as fontes fiscais da F2. Emenda o
[ADR-0038](0038-analise-de-documento-do-cliente.md) apenas no ponto em que ele
rejeitou uma segunda linha em `claim_evidence`: a linha agora existe, mas é uma
observação de verificação **sem `signal`**, portanto não conta a mesma prova
duas vezes no score.

Relaciona-se com o [ADR-0016](0016-claim-evidence-assessment.md) (observação e
avaliação), [ADR-0033](0033-verificacao-de-evidencias-por-adaptadores.md)
(contrato do verificador), [ADR-0035](0035-artefato-de-evidencia-tenant-scoped.md)
(artefato de PII), [ADR-0037](0037-intake-de-comprovante-do-cliente.md)
(intake F1.1), [ADR-0038](0038-analise-de-documento-do-cliente.md) (análise
F1.2) e [ADR-0039](0039-extracao-de-pdf-com-unpdf.md) (PDF com `unpdf`).

Não implementa NF3e/NFAg-e, OCR, VLM, consulta oficial, billing, link do
titular, wallet, credencial verificável nem mudança de scoring.

## Contexto

A F1.1 cria, na mesma transação:

```text
validation → claim → claim_evidence (unknown/pending) → evidence_artifact
```

A linha F1.1 tem `source = customer_submitted_document`,
`checker = customer_document_intake`, `stance = unknown` e
`detail.verification.status = pending`. Ela é imutável pelo trigger
`claim_evidence_guard_trg` e é o recibo do upload.

A F1.2 lê o artefato e persiste o resultado em `evidence_analysis`, uma linha
append-only por `(artifact_id, analyzer, analyzer_version, contract_version)`.
O analyzer **não** decide `authentic`, `matches` ou `differs`; ele só extrai
campos. Faltava transformar essa extração em uma evidência observável, com as
três dimensões independentes (`document`, `address`, `holder`), sem reescrever o
intake e sem alterar o `weightedScore`.

## Decisão

### 1. Uma observação de verificação separada do intake

A F1.3 materializa uma **nova linha** em `claim_evidence`:

```text
source          = 'uploaded_document'
checker         = 'document_upload_verification'
checker_version = política + analyzer_version + contract_version
stance          = política (F1.3: 'unknown')
strength        = 0
confidence      = 0
evidence_sha256 = hash do artefato
detail          = { verification: { ... } }
```

A linha F1.1 continua `pending` e imutável. As duas linhas têm papéis
diferentes:

- `customer_submitted_document` é o **recibo do intake**: “um documento foi
  apresentado”;
- `uploaded_document` é a **observação de verificação**: “o que a extração e a
  comparação concluíram sobre documento, endereço e titular”.

Atualizar a linha F1.1 seria mais simples, mas destruiria a auditoria e violaria
o trigger. Usar somente `evidence_analysis` manteria a conclusão invisível para
o modelo de evidências e para o `GET`.

### 2. Três dimensões no `detail`

O contrato puro está em `packages/core/src/evidence-verification.ts`:

```ts
document: 'authentic' | 'not_found' | 'invalid' | 'inconclusive' | 'unavailable' | 'unsupported'
address: 'matches' | 'differs' | 'not_extracted'
holder: 'matches' | 'differs' | 'not_extracted'
```

O `detail.verification` persistido contém apenas outcomes, status, método,
fonte, `analysis_id`, `artifact_id`, analisador, contrato, `observed_at`,
limitações, códigos de erro e códigos de razão da comparação. **Nenhum nome,
endereço, CEP ou CPF/CNPJ extraído é copiado para o `claim_evidence`.**

O documento enviado não é autenticado nesta etapa. Quando a extração termina, a
dimensão `document` fica `inconclusive` (um PDF legível não prova autenticidade)
e a política mantém `stance = 'unknown'`. `invalid`, `unsupported` e
`unavailable` são preservados. `unavailable`, `inconclusive` e `unsupported`
nunca viram `contradicts`.

### 3. Comparação de endereço

A comparação reutiliza os normalizadores existentes e compara **igualdade de
campos**, nunca substring:

- fortes: CEP, UF, logradouro, número;
- de apoio: bairro, cidade, complemento.

Conflito em qualquer campo forte produz `differs`. Bairro/cidade/complemento
divergentes sozinhos não produzem `differs`; eles apenas geram reason codes de
alerta quando os campos fortes coincidem. Sem campo forte comparável, o
resultado é `not_extracted`. A cidade é comparada quando
`ref_receita_municipio.nomeNorm` existe para o `municipio_ibge` do
`canonical_address`; o complemento não é persistido no endereço canônico.

### 4. Comparação de titular

A comparação é conservadora:

- normaliza caixa/acentos/espaços;
- remove sufixos societários no fim do nome (`LTDA`, `ME`, `EPP`, `EIRELI`,
  `S/A`, `SA`, `SOCIEDADE ANONIMA`, `MICROEMPRESA`, `EMPRESARIO INDIVIDUAL`);
- exige igualdade exata com a razão social (`ref_receita_empresa`) ou com o
  nome fantasia (`deep_context.record.nomeFantasia`);
- com razão social, um nome diferente retorna `differs`;
- sem razão social e apenas com nome fantasia, um nome diferente retorna
  `not_extracted` (`HOLDER_REFERENCE_WEAK`), porque o extraído pode ser a razão
  social que não temos;
- sem nome extraído ou sem referência, retorna `not_extracted`, nunca `differs`.

Não há similaridade difusa, comparação por iniciais, inferência de sócio nem
busca por CPF/CNPJ. O analyzer continua sem emitir identificador fiscal.

### 5. Versão, idempotência e leitura corrente

A chave natural é:

```text
(claim_id, checker, checker_version)
WHERE source = 'uploaded_document'
```

`checker_version` inclui a versão da política de comparação, a versão do
analisador e a versão do contrato de análise. Consequências:

- replay/retry da mesma análise não duplica;
- uma nova versão de política/analisador/contrato cria **outra** linha e
  preserva a anterior;
- a leitura corrente no `GET /v1/validations/:id` é a linha de
  `uploaded_document` com `observed_at` mais recente (desempate `created_at`);
- versões antigas permanecem no banco para auditoria e não são sobrescritas.

A fila do worker atravessa tenants com o pool de manutenção, mas a leitura e a
escrita do claim usam `withTenant`. O candidato exige igualdade de tenant entre
`evidence_analysis`, `evidence_artifact`, `claim_evidence` (intake) e `claim`.

### 6. Sem `signal` nesta etapa

A linha F1.3 **não** insere `signal`. Portanto:

- `weightedScore` e veredito não mudam;
- a mesma prova não é contada duas vezes no score;
- a extração/comparação fica disponível para a F3 decidir uma política de
  scoring;
- a F2 pode trazer `document = authentic` de fonte oficial e, aí sim, mapear
  `supports`/`contradicts` com uma fonte independente.

## Alternativas rejeitadas

1. **Atualizar a linha F1.1.** O trigger de imutabilidade impede; mesmo sem o
   trigger, reescrever o recibo do intake destruiria a auditoria.
2. **Guardar a verificação apenas em `evidence_analysis`.** A análise é uma
   etapa intermediária; a conclusão não entraria no modelo de evidências nem no
   `GET`. A F1.3 precisa de uma observação de `claim_evidence`.
3. **Criar uma tabela nova (`document_verification`, `verification_attempt`).**
   Duplicaria `claim_evidence`, o vínculo com o claim e a RLS sem necessidade.
4. **Inserir `signal` junto da linha.** Alteraria o score e anteciparia a
   decisão de scoring da F3; a F1.3 não tem fonte autenticada para justificar
   `supports`/`contradicts`.
5. **Sobrescrever a linha anterior a cada nova versão.** Perderia o histórico e
   impediria auditar por que uma versão antiga concluiu de forma diferente.
6. **Comparar endereço/titular por substring ou similaridade.** Produziria
   falsos `matches` (ex.: “Rua das Flores” vs “Rua das Flores II”) e falsos
   `differs` por variação de nome. A decisão é igualdade após normalização.

## Consequências

- `evidence_summary.unknown` pode contar a linha de intake e a linha de
  verificação. Isso é esperado: são observações distintas. O score não muda
  porque não há `signal`.
- O `GET /v1/validations/:id` passa a expor `evidence_verification`. O contrato
  é fechado para as três dimensões e códigos; valores extraídos continuam fora.
- Uma nova versão de análise não apaga a anterior; a leitura corrente é a mais
  recente por `observed_at`. Um backfill de versão antiga pode, no máximo, criar
  uma linha histórica; a política de “corrente” continua sendo temporal.
- A F1.3 não implementa OCR de imagem. Imagem continua `unsupported` na análise
  e, portanto, `document = unsupported`, `address/holder = not_extracted` na
  verificação.
- A F3 precisa decidir se uma política futura pode transformar um match de
  conteúdo em `supports`; a F2 precisa fornecer `authentic` para
  `supports`/`contradicts` com fonte independente.

## Segurança e LGPD

- `claim_evidence.detail` guarda somente outcomes/reason codes; não copia PII.
- Logs usam `analysis_id`, `artifact_id`, `claim_id`, `checker_version`,
  status/razão técnica e nome da classe de erro. Não logam nome, endereço, CEP,
  CPF/CNPJ, filename nem bytes.
- `evidence_analysis` continua sendo a única tabela com os campos extraídos e é
  apagada em cascata com o artefato na retenção.
- A linha de verificação é tenant-scoped; a fila global não contorna a RLS.
- O artefato continua no ObjectStore privado, sem URL/presigned; a verificação
  não lê bytes nem chama rede.

## Testes

`packages/core/src/evidence-verification.test.ts` cobre os comparadores e o
mapeamento determinístico. `apps/api/tests/evidence-verification.int.test.ts`
cobre:

- endereço/titular extraídos e `matches`;
- `address = differs` e `holder = differs`;
- `holder = not_extracted` sem titular;
- PDF sem camada textual → `not_extracted`, nunca `differs`;
- documento inválido → `document = invalid`, sem evidência válida;
- reprocessamento não duplica;
- nova versão cria nova linha e preserva a anterior;
- cross-tenant/RLS e `GET` sem vazamento;
- logs e `detail` sem PII.
