# LIA — Legitimate Interest Assessment (prevenção à fraude)

## 1. Objetivo do tratamento

Verificar se o endereço declarado por um CNPJ é consistente com evidências independentes
(cadastro público, CNEFE, geocoding, fachada) para **prevenir fraude** — ex.: empresas de
fachada em endereços de escritório contábil, ocupação por terceiros, endereços inexistentes.

## 2. Natureza do interesse

- Prevenção à fraude é interesse legítimo do **tenant** (ex.: adquirente verificando merchant,
  plataforma verificando seller) e do próprio mercado (art. 7º, IX c/c art. 10 do RGPD analogia;
  art. 7º, II LGPD — exercício regular de direitos / tutela em processo judicial/administrativo
  e prevenção à fraude).
- Para **CNPJ**: dados são públicos por lei (Receita Federal, dados abertos) — tratamento de
  dado público de PJ. Sócios PF aparecem como a fonte publica (nome mascarado pela RF).
- Para **CPF**: usamos **consentimento** (art. 7º, I) ou execução de contrato (V) — a base
  "interesse legítimo" não é usada para PF (decisão conservadora).

## 3. Necessidade e proporcionalidade

- O veredito não decide crédito/negócio sozinho: o contrato da API documenta que o cliente
  **não deve negar serviço apenas por um veredito** (em especial `RESIDENTIAL` — informacional).
- `INSUFFICIENT_EVIDENCE` é saída legítima — o sistema nunca força um sim/não sem evidência.
- Ausência de evidência (`unknown`) nunca é tratada como `contradicts` (design dos checkers).

## 4. Direitos e salvaguardas

- Explicabilidade: política versionada + sinais nominais + templates determinísticos.
- Contestação (art. 20): `POST /v1/validations/{id}/contest` → auditoria + revisão humana.
- Acesso/eliminação: relatório por subject + `DELETE /v1/subjects/{id}`.
- Pseudonimização por tenant, RLS, redação de logs com gate no CI.

## 5. Revisão

Revisar esta LIA: (a) ao habilitar chaves de API externas (OpenAI/Google), (b) ao entrar em
produção com dado real de terceiros, (c) anualmente.
