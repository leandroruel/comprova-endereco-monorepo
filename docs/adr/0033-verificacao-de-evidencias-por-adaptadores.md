# ADR-0033: Verificação de evidências por adaptadores e resultado tipado

## Status

Proposto (2026-10-22). **Não implementado.** Depende da decisão de escopo de
artefato (F0) e precede o adaptador NF3e (F2).

Relaciona-se com o [ADR-0016](0016-claim-evidence-assessment.md) (claim como
objeto de domínio) e com o [ADR-0034](0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
(como consultar fontes oficiais com segurança).

## Contexto

O domínio atual já separa:

```text
validation → claim → claim_evidence → assessment → verdict
                     ↘ evidence (artefato opcional)
```

Hoje a única fonte que materializa artefato é o street view/VLM
(`apps/worker/src/modules/evidence/evidence.service.ts`). O produto precisa
aceitar mais duas famílias de evidência:

- **documento do cliente** (comprovante de endereço: PDF/imagem);
- **consulta a fonte oficial** (NF3e; NFAg-e no futuro).

Sem um contrato explícito, cada adaptador inventaria seu próprio formato de
resultado e o scoring receberia um booleano ("confere/não confere"). Isso produz
três erros previsíveis:

1. **Colapsar dimensões independentes.** Um comprovante autêntico no nome de
   outra pessoa confirma que o endereço existe, mas não que o titular ocupa o
   imóvel. Um booleano diria "CONFIRMED".
2. **Tratar indisponibilidade como contradição.** Fonte fora do ar viraria
   `contradicts`, penalizando o cliente por um problema do fornecedor.
3. **Duplicar o domínio.** Nasceriam tabelas `document`/`verification`, paralelas
   a `claim_evidence`, contra a decisão do ADR-0016.

## Decisão

Adotar um **contrato único de verificação de evidências**, implementado por
adaptadores de fonte, que devolve um **resultado tipado em três dimensões
independentes**:

```text
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

Regras vinculantes:

1. **Persistência não muda de dono.** O resultado é gravado como **uma** linha
   em `claim_evidence` (com as dimensões em `detail`), opcionalmente vinculada a
   `evidence` por `evidence_id`. Não se cria tabela de documento nem de
   tentativa.
2. **`unavailable`, `inconclusive` e `unsupported` mapeiam para `unknown`.**
   Nunca para `contradicts`. Teste obrigatório.
3. **`not_found` só contradiz quando a consulta foi conclusiva no autorizador
   competente.** "Não achei" não é prova de fraude.
4. **A dimensão `holder` é separada da `address`.** O adaptador não decide o
   veredito; ele informa as três dimensões e a política mapeia.
5. **Uma observação por fonte.** Não se emite uma linha por dimensão, para não
   contar a mesma prova três vezes no score aditivo (`weightedScore`).
6. **Credencial não é evidência.** A credencial continua sendo saída da
   validação (`@comprova/credential`), não entrada do verificador.

### Escopo do contrato

O contrato é de **domínio puro** (sem I/O de rede e sem dependência de banco),
como `packages/core` e `packages/credential`. O adaptador concreto (NF3e,
upload, etc.) implementa o contrato e é injetado no pipeline. A primeira
implementação real deve ser o adaptador NF3e; a segunda, o intake de documento.
Se apenas uma existir, **não** criar a abstração — implementar direto e extrair
o contrato quando a segunda chegar.

## Consequências

Positivas:

- O modelo existente (`claim_evidence.detail` jsonb) absorve as novas fontes sem
  migração.
- O score e a explicação continuam funcionando com o que já existe.
- Indisponibilidade de fonte não penaliza o cliente.
- A distinção autenticidade × endereço × titular fica auditável.
- O próximo adaptador (NFAg-e) reusa o contrato sem tocar no domínio.

Negativas / custos:

- Exige disciplina de mapeamento para `stance` em cada fonte.
- O `detail` jsonb precisa de convenção documentada (não é schema imposto pelo
  banco).
- `weightedScore` continua aditivo; a independência entre fontes fica como
  decisão futura (`SCORER_VERSION=2`), não resolvida por este ADR.

## Alternativas consideradas

| Alternativa                                | Por que não                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Booleano `verified` por documento          | Perde as três dimensões e produz "CONFIRMED" indevido                      |
| Tabela `document` + `document_field`       | Duplica o domínio do ADR-0016; migração sem necessidade demonstrada        |
| Uma linha de `claim_evidence` por dimensão | Conta a mesma fonte múltiplas vezes no score aditivo                       |
| Deixar cada checker criar seu formato      | Sem contrato, cada fonte vira um caso especial e o score fica imprevisível |

## Fora de escopo

- Implementar upload, OCR, adaptador NF3e ou qualquer endpoint.
- Alterar `weightedScore`, `SCORER_VERSION` ou `policies/*.yaml`.
- Definir se o artefato fica em `evidence` ou em tabela tenant-scoped (F0).
- OID4VCI/VP/wallet.
