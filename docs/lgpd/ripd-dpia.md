# RIPD / DPIA — rascunho

Sistema: comprova-endereco · Data: 2026-10-14 · Versão: rascunho (revisar com DPO antes de prod)

## 1. Descrição do tratamento

API que valida o endereço de um CNPJ/CPF cruzando múltiplos sinais (cadastro público,
CEP/CNEFE, geocoding, fachada) e devolve veredito explicável com score de confiança e trilha
de auditoria. Titulares: representantes de PJ (dado público) e PF (quando o próprio tenant
consulta CPF com consentimento).

## 2. Necessidade e proporcionalidade

- **Necessidade**: prevenir fraude de endereço (verificar compatibilidade do endereço declarado
  com a realidade), com resultado explicável para revisão humana.
- **Minimização**: documento apenas como HMAC; endereço de PF como chaves normalizadas;
  resposta limitada a veredito + sinais (sem dossiê por padrão, `include_evidence` opt-in).
- **Pseudonimização**: `doc_hmac` com chave por tenant (ADR-0005); `deep_context` no workflow
  contém só dado público de PJ.

## 3. Decisão automatizada (art. 20)

- Toda validação grava: `policy_version` (política imutável versionada), os sinais com
  stance/força/confiança/fonte e uma explicação gerada por **templates determinísticos**
  (não LLM-livre).
- Revisão humana possível via: `GET /v1/validations/{id}` (sinais completos),
  `POST /v1/validations/{id}/contest` (contestação auditada + evento para fila de revisão).
- `INSUFFICIENT_EVIDENCE` é resultado legítimo: ausência de evidência não é evidência de
  ausência; o sistema nunca força binário.

## 4. Riscos e mitigação

| Risco                                | Mitigação implementada                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Vazamento de CPF/CNPJ de PF em logs  | Redator central com testes anti-vazamento no CI (gate)                                                    |
| Acesso cross-tenant                  | RLS FORCE no banco + testes de isolamento no CI                                                           |
| Reconstrução de identidade via HMAC  | Chave por tenant (KMS em prod); HMAC não é anonimização — registrada como limitação                       |
| Viés/dano por veredito `RESIDENTIAL` | Informacional por design; contrato documenta que o veredito isolado não deve negar serviço                |
| Retenção excessiva                   | `expires_at` nas validações, `retention_until` nas evidências + job de retenção                           |
| Evidência com rostos/placas          | Prompt proíbe descrever pessoas; persistência de imagem desligada por padrão (`STORE_STREET_VIEW_IMAGES`) |
| Direitos do titular                  | `DELETE /v1/subjects/{id}` (eliminação auditada) + relatório de acesso por subject                        |

## 5. Transferência internacional

Perfil atual: nenhum dado pessoal sai do ambiente local. Quando Nominatim/Overpass/OpenAI/Google
forem efetivamente usados com dado pessoal, atualizar esta seção com cláusulas de transferência
(OpenAI/Google = EUA; considerar substitutos localizáveis).
