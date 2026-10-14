# ADR-0014: Fase 5 — fluxo CPF, direitos do titular e conformidade LGPD

## Status

Aceito (2026-10-14)

## Contexto

CPF não existe em base pública de endereço: o endereço só chega por request com base legal
(consentimento/contrato). Fase 5 fecha o ciclo LGPD: direitos do titular, contestação (art. 20),
documentação e stub de atestados verificáveis (seção 15 da spec).

## Decisão

### Fluxo CPF

- `POST` com `document.type=CPF` exige `address` (ou `consent_ref` resolvível — hoje só o
  address direto) e `legal_basis` — 422 `ADDRESS_REQUIRED_FOR_CPF` (implementado desde a F1).
- **Enriquecimento por CEP** (novo no fast path): quando o request traz endereço sem
  `municipio_ibge`, o fast path consulta `ref_cep` e preenche o município — a validação
  CEP↔UF↔município da spec passo 2 acontece antes da canonicalização/CNEFE.
- **Vereditos para CPF** (sem registro comercial):
  - CNEFE exato residencial → hint `RESIDENTIAL` (novo no `cnefe_match`, condicionado a
    `docType === 'CPF'`) → veredito `RESIDENTIAL`.
  - CNEFE exato não-residencial + CEP consistente → `CONFIRMED_COMMERCIAL` — semântica: o
    **endereço** está confirmado como estabelecimento não-residencial.
  - Sem evidência → `INSUFFICIENT_EVIDENCE` (legítimo).
- `consent_ref` agora é persistido na `validation` (corrigido: antes era aceito e descartado)
  e devolvido no relatório do titular.

### Direitos do titular

- **Relatório de acesso**: `GET /v1/subjects/{id}/validations` (validações, base legal,
  `consent_ref`, datas) — sem PII além do que o titular já declarou.
- **Eliminação**: `DELETE /v1/subjects/{id}` — transacional (validações + sinais + idempotência
  - subject), com `audit_log` (`subject.erasure`) e evento `subject.erased` no outbox; RLS
    garante 404 cross-tenant. Endereços canônicos permanecem (dados de chave, sem PF em claro).
- **Contestação (art. 20)**: `POST /v1/validations/{id}/contest {reason}` → auditoria
  (comprimento da razão, não o texto — minimização) + evento `validation.contested` para a
  fila de revisão. Fluxo operacional documentado em `docs/lgpd/contestacao.md`.

### Conformidade (documentação)

- `docs/lgpd/`: mapa de dados, RIPD/DPIA (rascunho), política de retenção (mecanismos reais
  por tabela), LIA de prevenção à fraude, fluxo de contestação.
- **Gate "zero PII em logs"**: teste de integração captura o log da API durante fluxo CPF
  completo e falha se CPF cru ou logradouro aparecer — no CI.

### AttestationVerifier (stub, seção 15 da spec)

- `packages/core/src/attestation.ts`: porta `AttestationVerifier` com tipos de
  `AddressAttestation` (formato `bbs-plus`/`zk-snark`/`jwt-vc`, issuer, claims de escopo
  geográfico — país/município/prefixo de CEP, validade) e stub que rejeita com motivo claro.
- **Formato esperado (para o integrador futuro)**: prova de residência emitida por terceiro
  confiável, verificável **sem receber o documento do titular** — verificação de assinatura/
  prova contra chave pública do issuer, claims de escopo (nunca endereço completo), expiração
  curta. Quando implementado, um checker T1 consome o atestado como sinal `supports` de
  endereço sem expor o dado.

## Alternativas rejeitadas

- **Endereço de PF persistido em claro para consulta futura**: violaria minimização; o fluxo
  usa chaves normalizadas + `consent_ref`.
- **`CONFIRMED_COMMERCIAL` bloqueado para CPF**: o veredito descreve o endereço; negá-lo
  deixaria o fluxo CPF sem saída positiva quando o CNEFE/CEP confirmam estabelecimento.

## Consequências

- O dataset dourado ganha implicitamente cobertura CPF via testes f5 (RESIDENTIAL e
  CONFIRMED por CNEFE).
- Fase 5 entregue; checklist LGPD completo no `docs/lgpd/`; gates no CI (erasure, RLS,
  contestação, zero-PII em logs).
