# Roadmap canônico — Comprova

> **Status:** documento canônico a partir de 2026-10-22.
> **Escopo:** produto e arquitetura (não é changelog).
> **Changelog:** [`PROGRESS.md`](../PROGRESS.md) continua sendo o log cronológico do
> que foi entregue. Este arquivo diz **o que vem depois, em que ordem e por quê**.
> **Contexto de arquitetura:** [`docs/architecture.md`](architecture.md) (estado
> atual) e [`docs/arquitetura-evidencias.md`](arquitetura-evidencias.md) (alvo de
> evidências e fontes fiscais).

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
 ├──► F1 (comprovante convencional / upload)
 │     ├──► F2 (NF3e)
 │     │     └──► F4 (atualização pelo titular)
 │     └──► F3 (medição e cobrança)
 ├──► F5 (credencial no fluxo B2B)      [usa o que já existe de VC]
 └──► F6 (operação e segurança contínua)

F7 (NFAg-e / expansão fiscal)  ← gate: norma definitiva + demanda + F2 madura
F8 (SSI: OID4VCI/VP/wallet)    ← gate: verificador/holder externo exigindo
```

Paralelismo permitido: **F3 pode rodar junto com F2** depois que F1 define o
vocabulário de eventos. **F5 pode rodar junto com F1/F2** porque a camada de
credencial já está construída.

---

## Fase 0 — Baseline de produção e integridade (P0)

**Objetivo:** fechar as lacunas que tornam inseguro aceitar documento de cliente
ou consultar fonte externa. Nenhuma feature nova de produto.

### Estado atual comprovado

| Item                      | Evidência                                                                                                        | Situação                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Idempotência de validação | `apps/api/src/services/fastpath.ts` (`findExistingIdempotency`, `requestHashOf`) + `validation_idempotency`      | Funciona; replay não reescreve e não reemite `usage_event`                                                                   |
| RLS multi-tenant          | `packages/db/migrations/0007_rls.sql`, `withTenant`                                                              | FORCE em `subject`, `validation`, `claim`, `claim_evidence`, `usage_event`, `audit_log`, `webhook_*`, `batch*`               |
| Retenção de validação     | `apps/worker/src/modules/retention/retention.service.ts` + loop em `apps/worker/src/loops.ts`                    | Job diário existe e apaga o grafo                                                                                            |
| Guarda de URL de webhook  | `apps/api/src/modules/webhooks/webhook-crypto.ts` (`isSafeWebhookUrl`)                                           | Só `https` + regex de host privado; **sem DNS, sem IP resolvido, sem limite de tamanho/content-type**                        |
| `evidence` global         | `packages/db/migrations/0005_validation.sql`, `0007_rls.sql`, `0008_grants.sql`                                  | **Sem `tenant_id`/RLS**; único escritor hoje é o VLM de street view (`apps/worker/src/modules/evidence/evidence.service.ts`) |
| Artefato de PII           | `packages/db/migrations/0039_evidence_artifact.sql`, [ADR-0035](adr/0035-artefato-de-evidencia-tenant-scoped.md) | **Entregue em F0.1**: `evidence_artifact` tenant-scoped, RLS FORCE, write-once; sem upload/OCR                               |
| Expiração de validação    | `fastpath.ts` (`expires_at = now + 30d`)                                                                         | 30 dias hardcoded, não vem da policy                                                                                         |
| Dashboard e API key       | `apps/dashboard/src/api/client.ts`                                                                               | Chave de tenant vai no bundle do browser; o próprio código marca como "facilidade de desenvolvimento"                        |

### Lacunas

1. **Não existe guarda de fetch genérica.** A proteção de SSRF cobre apenas o
   cadastro do webhook e não resiste a DNS rebinding, IP literal privado,
   redirect para rede interna, corpo gigante ou conteúdo inesperado. Qualquer
   consulta a URL de fonte fiscal (F2) precisa de uma guarda única e testada.
2. **`evidence` é global por design**, o que é correto para imagem pública de
   street view e **incorreto** para comprovante com dado pessoal do cliente. A
   fundação tenant-scoped foi entregue em F0.1 (`evidence_artifact`, ADR-0035);
   o intake com PII continua sendo F1.
3. **Não há checklist de produção** para issuer origin definitivo, KMS por
   tenant, restore de backup, alarmes e capacidade.

### Escopo

- Desenhar e testar uma guarda de fetch reutilizável (allowlist, resolução DNS
  com bloqueio de faixas privadas/link-local/metadata, sem redirect, limites de
  tempo/tamanho/content-type, IP fixado na conexão).
- ~~Decidir o escopo tenant de artefato enviado pelo cliente~~ **Entregue em
  F0.1**: `evidence_artifact` tenant-scoped, RLS FORCE e FK composta. A remoção
  atual ocorre no fluxo de retenção após a expiração da validação;
  `retention_until` ainda não define o prazo comercial do binário (ADR-0035;
  migration 0039).
- Definir o **evento faturável canônico** (uma validação nova = no máximo um
  evento; replay/retry = zero) antes de F3 implementar.

### Fora de escopo

- Endpoint de upload, OCR, consulta fiscal, OID4VCI/VP, wallet.
- Refactor preventivo de módulos que não serão tocados.

### Critérios de conclusão

- Testes negativos da guarda de fetch: `localhost`, `127.0.0.1`, `169.254.169.254`,
  RFC1918, IPv6 loopback, host que resolve para IP privado, redirect para host
  privado, corpo acima do limite, `content-type` fora da allowlist.
- Teste provando que um artefato de um tenant não é legível por outro.
- `docs/lgpd/retencao.md` e README alinhados ao código (verificação por revisão
  e por link).
- Checklist de produção anexado a este roadmap ou a um runbook.

### Riscos

- Escolher errado o modelo de `evidence` contamina F1/F2 e gera migração
  dolorosa depois. **É a decisão mais importante desta fase.**
- Guarda de fetch mal implementada dá falsa sensação de segurança.

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

## Fase 1 — Comprovante convencional: upload e análise (P1)

**Objetivo:** receber um comprovante de endereço (conta de luz/água/telefone,
PDF ou imagem), extrair os campos e transformá-lo em `claim_evidence` com
resultado explícito — **sem depender de fonte fiscal**.

Esta é a fase do requisito de produto já confirmado ("upload de comprovante") e
a que mais destrava valor: hoje o produto só valida endereço por registro
público.

### Estado atual comprovado

| Item                           | Evidência                                                                                        | Situação                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Endpoint de upload             | `apps/api/src/modules/validations/validations.routes.ts`                                         | **Não existe**; só `POST /v1/validations`, `GET`, contest, credential |
| Multipart / parsing de arquivo | dependências de `apps/api/package.json`                                                          | **Não existe**                                                        |
| Extração OCR/PDF               | `packages/providers/src/vision-model.ts` (VLM de fachada)                                        | Existe para fachada, não para documento                               |
| Persistência de evidência      | `packages/db/migrations/0005_validation.sql` (`evidence`), `0023` (`claim_evidence.evidence_id`) | Modelo suporta artefato + vínculo; escrita só via street view         |
| Vínculo com claim              | `claim_evidence` (`stance`, `strength`, `confidence`, `detail`, `evidence_id`)                   | **Suficiente** para representar a observação sem tabela nova          |

### Lacunas

1. Não há caminho de entrada para documento do cliente (HTTP, storage, limites).
2. Não há identificação de tipo de documento por **conteúdo** (só por intenção do
   usuário). Nome de arquivo e `content-type` declarado não são confiáveis.
3. Não há extração de campos (titular, documento, endereço, competência) nem
   normalização contra `canonical_address`.
4. Não há política de "documento autêntico ≠ titular mora aqui": o comprovante
   pode confirmar a existência do endereço sem confirmar o vínculo com o titular.
5. `evidence.kind` é texto livre; não há vocabulário controlado de tipo de
   documento.

### Escopo

- Endpoint autenticado e com scope, idempotente, com limite de tamanho e
  allowlist de content-type **verificada por sniffing**, não por header.
- Storage privado (S3/R2) com chave por tenant e retenção explícita; gravar
  `sha256` e metadados.
- Identificação de tipo por conteúdo (PDF: texto/estrutura; imagem: OCR).
- Extração e normalização: titular, documento do titular, endereço, data de
  emissão/competência.
- Matching em **três dimensões independentes**: documento reconhecido, endereço
  confere, titular confere.
- Gravar **uma** observação por fonte em `claim_evidence`, com o detalhe
  estruturado em `detail` (ver contrato em
  [`arquitetura-evidencias.md`](arquitetura-evidencias.md)).
- Resultado tipado e explicação; nunca `contradicts` por falha de extração.

### Fora de escopo

- Consulta a autorizador fiscal (F2).
- Detecção de fraude/adulteração por modelo próprio.
- Revisão humana como produto (pode existir como operação interna).
- Emissão de credencial a partir do upload.

### Critérios de conclusão

- Fixtures sintéticas (não PII real) para PDF e imagem, com teste de tipo
  errado, arquivo corrompido, acima do limite e cross-tenant.
- Retry idempotente não cria `claim_evidence` duplicado.
- Nenhum dado pessoal em log; `doc_hmac` continua sendo o identificador do
  subject.
- Resultado do upload aparece no `GET /v1/validations/:id` com o mesmo formato
  já usado por `claim`/`evidence_summary`.

### Riscos

- OCR de baixa qualidade gera falso `not_confirmed`. Mitigação: resultado
  `inconclusive` explícito e confiança baixa, nunca `contradicts`.
- Custo de storage e LGPD se o binário for retido sem necessidade.

### Decisões abertas

- Biblioteca de OCR/PDF (runtime dep só quando a fase começar).
- Guardar binário ou apenas hash + campos? (mesma decisão de F0).
- Upload cria validação nova ou anexa a uma validação existente? Recomendação:
  anexar quando `validation` está `partial`/`completed`; criar nova quando o
  pedido é uma atualização (F4).

---

## Fase 2 — Verificação fiscal: NF3e (P1, após F1)

**Objetivo:** confirmar um comprovante de energia contra o autorizador oficial,
aumentando a confiança e reduzindo revisão manual. **Não** substitui a extração
de F1: soma uma fonte.

### Estado atual comprovado

- **Nada fiscal existe no código.** Nenhum adaptador, nenhuma allowlist, nenhuma
  tabela de fonte.
- `claim_evidence.source` já é texto livre e `detail` é `jsonb` — o modelo
  comporta a observação sem migração.
- A guarda de fetch necessária **não existe** (ver F0).

### Fatos externos verificados em 2026-10-22

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

### Escopo

- Contrato `EvidenceVerifier` (ADR-0033) com resultado tipado em dimensões
  independentes.
- Adaptador NF3e: identificar o documento, extrair a chave de acesso, resolver o
  autorizador **no servidor**, consultar somente URL da allowlist, normalizar a
  resposta.
- Tabela de autorizadores versionada em código (UF → autorizador → endpoint de
  consulta → ambiente), com testes por autorizador.
- Estado da fonte (`available`, `degraded`, `unavailable`, `unsupported`) e
  mapeamento para `unknown` — **nunca** `contradicts` por indisponibilidade.
- Fixtures de respostas gravadas; **nenhuma chamada de rede no CI**.
- Métricas por fonte: latência, taxa de `unavailable`, cache hit.

### Fora de escopo

- NFAg-e (F7).
- Serviços SOAP de emissão/assinatura (o produto consulta, não emite).
- Cobertura nacional declarada sem autorizador confirmado.
- Validação de assinatura XML como requisito (pode virar P2 se o cliente exigir).

### Critérios de conclusão

- Para cada autorizador suportado, fixture → `outcome` correto.
- Teste provando que URL de QR fora da allowlist não gera fetch.
- Teste provando que `source_unavailable` mapeia para `unknown`.
- Latência p95 dentro do orçamento definido (ex.: 5 s) e timeout explícito.
- Documentação de quais UFs são suportadas e de quais não são.

### Riscos

- Instabilidade/HTML cambiante dos portais. Mitigação: contrato + fixtures +
  alarme de regressão, não scraping frágil.
- Aspecto legal/ToS da consulta automatizada.
- Falsa sensação de "cobertura nacional".

### Decisões abertas

- Quais UFs primeiro? (demanda comercial, não conveniência técnica).
- Consulta pública por QR apenas, ou SOAP com certificado?
- Cachear resposta por chave por quanto tempo? (documento é imutável; cache é
  seguro com TTL e auditoria)
- Guardar o HTML/XML bruto ou só hash + campos normalizados?

---

## Fase 3 — Medição de uso e cobrança (P1)

**Objetivo:** tornar o consumo auditável e faturável sem contar duas vezes.

### Estado atual comprovado

| Item          | Evidência                                                                     | Situação                                                                     |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Evento de uso | `packages/db/src/schemas/usage.ts` (`usage_event`)                            | Existe: tenant, ocorrido em, `kind`, `units`, `cost_micros`, `validation_id` |
| Inserção      | `fastpath.ts` (`kind: 'fast'`), `deep-enrich.persistence.ts` (`kind: 'deep'`) | Uma vez por validação nova; replay não insere                                |
| Planos/cotas  | busca no repo                                                                 | **Não existe**                                                               |
| Ledger/fatura | busca no repo                                                                 | **Não existe**                                                               |
| Stats         | `apps/api/src/modules/stats/stats.service.ts`                                 | Deriva de `validation`, **não** de `usage_event`                             |

### Lacunas

1. `kind` é texto livre (`'fast'`/`'deep'`) — não há vocabulário estável de evento
   faturável.
2. Não há chave de idempotência/unique em `usage_event`; concorrência ou retry
   pode duplicar em cenários futuros.
3. Não há noção de "evento faturável" separada de "tentativa": fonte
   indisponível, reprocessamento e contestação não têm regra.
4. Cotas/limites por tenant não existem; rate limit não é cota comercial.
5. Stats e cobrança olham fontes diferentes, então podem divergir.

### Escopo

- Definir o evento canônico (por validação concluída? por documento? por
  tentativa?) e documentar as regras de não cobrança.
- Evoluir `usage_event` de forma aditiva: vocabulário de `kind`, chave de
  idempotência/unique, metadados de fonte/tentativa, flag de faturável.
- Cota por tenant (soft/hard) com auditoria.
- Consulta/exportação de uso reconciliável com `validation`.
- Alarme de divergência entre `usage_event` e validações concluídas.

### Fora de escopo

- Gateway de pagamento, nota fiscal, tabela de preços (decisão comercial).
- Rate limit de proteção (já existe; não é cota).

### Critérios de conclusão

- Teste de concorrência: duas requisições simultâneas com a mesma
  `idempotency-key` geram um evento.
- Reprocessamento e replay não geram evento.
- Consulta de reconciliação bate com `validation` para uma janela.
- Regra de fonte indisponível documentada e testada.

### Riscos

- Cobrar por tentativa desalinhado com valor percebido; cobrar por validação
  quando o cliente faz polling.
- Migração de `usage_event` particionada exige cuidado.

### Decisões abertas

- Unidade de cobrança: validação, documento único ou consulta a fonte.
- Fonte indisponível é faturável? Recomendação: **não**.
- Revalidação do mesmo documento em 30 dias é nova cobrança?
- Quem é o "cliente" no dashboard se todos usam a mesma API key? (ver F6)

---

## Fase 4 — Atualização solicitada pelo banco (P2)

**Objetivo:** o banco pede atualização; o titular recebe um link seguro,
envia novo comprovante; o resultado é explícito, com histórico preservado.

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

### Escopo

- Token opaco, single-use, com expiração, vinculado a tenant + subject +
  validação de origem; rate limit e auditoria.
- Captura de consentimento (versão do texto, timestamp, IP/UA quando aplicável)
  — entidade nova só se necessário.
- Reuso do intake de F1 para o novo comprovante.
- Resultado de comparação explícito: `improved`, `unchanged`, `diverged`,
  `inconclusive`.
- Vínculo de substituição (provável coluna aditiva
  `validation.supersedes_validation_id`, decidida só aqui).
- Nunca sobrescrever validação/credencial antiga.

### Fora de escopo

- Wallet, OID4VP, autenticação do titular por gov.br (avaliar depois).
- Portal do titular como produto separado.

### Critérios de conclusão

- Token não funciona cross-tenant, expirado ou reutilizado.
- Divergência produz resultado explícito e não apaga o histórico.
- Auditoria registra quem pediu, quem respondeu e quando.
- Teste de concorrência no consumo do token.

### Riscos

- Vazar PII no link (não colocar documento/endereço na URL).
- Confundir "atualização" com "contestação" (já existe `contest`).

### Decisões abertas

- Link é por validação ou por caso? Existe entidade "caso"?
- Quem é o titular: pessoa do `subject` ou quem recebe o link?
- Consentimento é por validação ou por finalidade?

---

## Fase 5 — Credencial verificável no fluxo B2B (P2)

**Objetivo:** transformar a camada de credencial já construída em produto:
emitir sob demanda, entregar, verificar de forma independente e revogar.

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
4. Não está decidido se a credencial é por validação, por subject ou por caso.
5. Não há vínculo de holder (quem é o dono da credencial).

### Escopo

- Definir o papel: recibo verificável para o cliente B2B **ou** credencial do
  titular. São produtos diferentes.
- Kit de verificação: documento + exemplo executável + chaves públicas.
- Decidir formato de status (manter endpoint atual ou adotar status list padrão).
- Semântica de TTL documentada para o cliente (credencial expira antes/depois da
  evidência?).
- Se houver holder: binding explícito e consentimento.

### Fora de escopo

- OID4VCI, OID4VP, wallet, divulgação seletiva (F8).
- Emissão de credencial a partir de upload sem validação.

### Critérios de conclusão

- Um verificador externo (sem banco) consegue validar assinatura, issuer,
  status e expiração seguindo a documentação.
- Revogação propaga e é observável.
- Teste de DID resolution e de chave rotacionada.

### Riscos

- Credencial reutilizável reduz consultas faturáveis — decisão comercial, não
  técnica.
- Status caseiro não interopera com verificadores de mercado.

### Decisões abertas

- Credencial é o produto ou o recibo?
- Status próprio vs status list padrão.
- Há holder ou só cliente corporativo?

---

## Fase 6 — Operação e segurança contínua (P2)

**Objetivo:** sustentar produção com fonte externa e documento de cliente.

Escopo:

- Runbooks: autorizador fora do ar, resposta inesperada, vazamento de artefato,
  revogação de chave, restore.
- Alarmes: taxa de `unavailable`, latência por fonte, divergência de uso, falha
  de retenção.
- Capacidade e custo (storage de artefato, OCR).
- Revisão de acesso: dashboard com API key compartilhada (ver decisão abaixo),
  rotação de pepper, escopos.
- Teste de restore e de revogação em produção.

Critérios: cada runbook executado em ensaio; alarme dispara em cenário
simulado; restore dentro do RPO/RTO definido.

Decisão aberta crítica: **o dashboard não é multi-tenant por cliente** — usa uma
`VITE_API_KEY` única e `user_id` só particiona stats. Para vender B2B, isso
precisa virar sessão/BFF ou uma chave por tenant, com isolamento real.

---

## Fase 7 — Expansão fiscal: NFAg-e e outras fontes (P3, com gate)

**Gate:** norma definitiva publicada + autorizador estável + demanda de cliente +
F2 madura.

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

Escopo: reutilizar o contrato e a guarda de F2; adicionar autorizador/fonte sem
tocar no domínio; declarar explicitamente o que não é suportado.

Fora: gás/outros documentos sem autorizador confirmado.

---

## Fase 8 — SSI: OID4VCI/VP/wallet (P3, com gate)

**Gate:** um verificador ou holder externo **exigir** o protocolo. Sem isso, o
custo (novos endpoints, superfície de segurança, suporte, interoperabilidade)
não se paga.

O que já existe e deve ser preservado: VC 2.0, DID, prova, status, revogação,
verificador. O que falta é protocolo de emissão/apresentação e wallet.

Não confundir "SSI" com "credencial": o valor B2B atual está na verificação de
endereço e no recibo verificável, não em uma wallet.

---

## Revisão crítica do que existia

### Manter

| Item                                             | Por quê                                        |
| ------------------------------------------------ | ---------------------------------------------- |
| Camada de credencial (ADRs 0019–0032)            | Entregue, testada, correta; é ativo, não custo |
| `claim → claim_evidence → assessment` (ADR-0016) | Espinha dorsal; evita segundo domínio          |
| Idempotência, RLS, outbox, retenção              | Já resolvem problemas reais                    |
| Fast path T0                                     | É o produto que já funciona e vende            |
| KMS como backend de produção                     | Requisito de segurança                         |

### Reordenar

| Item                        | De → Para                         | Motivo                                                                                               |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SSI/wallet/OID4VCI/VP       | próxima etapa → F8 (P3)           | Sem demanda comprovada; alto custo; não destrava receita                                             |
| Deep path/VLM               | prioridade alta → depois de F1/F2 | `VLM_ENABLED=false` por default e depende de chave paga; documento do cliente é requisito confirmado |
| Credencial como "o produto" | protagonista → F5 (P2)            | O B2B paga por verificação; credencial reutilizável reduz consulta                                   |
| Roadmap #24 (signing keys)  | aberto → **concluído**            | 24.1/24.2/24.3 entregues; vira histórico                                                             |

### Adiar ou descartar

| Item                      | Decisão                  | Motivo                                         |
| ------------------------- | ------------------------ | ---------------------------------------------- |
| Cobertura fiscal nacional | **descartar a premissa** | Só autorizadores confirmados; declarar UF a UF |
| NFAg-e agora              | adiar para F7            | Minuta sem ato definitivo; só SVRS             |
| Wallet própria            | adiar/descartar no MVP   | Não é diferencial                              |
| Segundo roadmap           | **não criar**            | Este arquivo é o canônico                      |

### Adicionar

| Item                                | Fase            | Por quê                                 |
| ----------------------------------- | --------------- | --------------------------------------- |
| Upload/análise de comprovante       | F1              | Requisito confirmado e ausente          |
| Contrato de verificador + taxonomia | F0/F2           | Evita "booleano mágico" e duplicação    |
| Guarda de fetch (SSRF real)         | F0              | Pré-requisito de qualquer fonte externa |
| Medição faturável                   | F3              | Sem isso não há receita auditável       |
| Link seguro do titular              | F4              | Requisito de atualização                |
| Policy por cliente/caso             | F3/F5 (decisão) | Hoje só existe policy global            |

## Decisões de produto em aberto

1. **Unidade de cobrança** e o que não é faturável.
2. **Dashboard multi-tenant**: chave por tenant + sessão/BFF vs continuar
   single-tenant de dev.
3. **Artefato**: por quanto tempo reter o binário no object storage privado (o
   armazenamento já foi decidido no ADR-0035). Hoje a remoção segue a expiração
   da validação; `retention_until` ainda não controla o ciclo de vida do binário.
4. **Policy por cliente**: necessária para o primeiro contrato ou pode ser
   global com contrato de versão?
5. **Credencial**: recibo B2B ou credencial do titular?
6. **Titular**: como se autentica no link de atualização?
7. **UFs iniciais** de NF3e.
8. **Consulta fiscal**: QR público apenas ou SOAP com certificado?

## Próxima tarefa concreta de implementação (não executada)

**F0.2 — Guarda de fetch compartilhada, com testes negativos, aplicada ao
webhook e pronta para a fonte fiscal.**

Entregável:

- um módulo único de fetch de saída (sem dependência nova de runtime, usando
  `undici`/`fetch` nativo) que resolve o host, rejeita IP privado/loopback/
  link-local/metadata, fixa o IP validado, não segue redirect, limita tempo e
  tamanho e valida content-type;
- `isSafeWebhookUrl` deixa de ser a única barreira: a entrega do webhook passa a
  usar a guarda no momento do envio;
- testes negativos listados em [F0](#fase-0--baseline-de-produção-e-integridade-p0);
- métrica de bloqueio por motivo.

Por que esta e não outra:

- não depende do intake de artefato (F1); a fundação F0.1 já foi entregue;
- não muda schema, endpoint público nem comportamento de produto;
- é pré-requisito real de F2 e fecha uma lacuna de segurança já existente.

**F0.1 (entregue em 2026-10-22):** `evidence_artifact` tenant-scoped, RLS FORCE,
FK composta, storage de objetos reutilizado, retenção integrada e testes de
isolamento/integridade (ADR-0035; migration 0039). A decisão que faltava está
tomada; o próximo passo é F0.2.
