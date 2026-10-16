# ADR-0016: Claim como objeto de domínio explícito (Claim → Evidence → Assessment)

## Status

Aceito (2026-10-16)

## Contexto

O pipeline atual é linear:

```text
validation → signals → scoring → verdict
```

O `signal` é a observação produzida por um checker, mas o sistema nunca explicita
**qual afirmação** está sendo avaliada, **quem é o sujeito**, **qual é o alvo** nem
**quais evidências sustentam ou contradizem** essa afirmação. Isso trava a evolução
para casos de uso futuros que exigem rastreabilidade semântica:

- explicabilidade regulatória ("por que este veredito?");
- preparação para Verifiable Credentials / SSI (a camada de credenciais precisa de
  uma afirmação estruturada com sujeito, alvo e evidências — não de uma lista de
  sinais soltos);
- claims com semânticas distintas (endereço comercial registrado vs. endereço
  existente vs. endereço residencial) sem sobrecarregar o veredito.

## Decisão

Evoluir o domínio para:

```text
validation → claim → evidence → assessment → verdict
```

conceitos:

- **claim** — a afirmação que se tenta estabelecer (ex.: "a organização X possui o
  endereço registrado Y"). Possui identidade própria (`claim_id` opaco), sujeito e
  alvo referenciados por UUID internos (nunca CPF/CNPJ em claro).
- **evidence** — representação persistente e rastreável de uma observação de
  checker a favor/contra um claim: checker + versão + fonte + stance + força +
  confiança + observação + TTL + detalhe.
- **assessment** — a conclusão de avaliar o conjunto de evidências contra uma
  policy (veredito, score, confiança, explicação).

### Tipos de claim (fase 1)

- `business_registered_address` — sujeito `organization` (CNPJ com endereço de
  registro). Não afirma funcionamento físico nem legitimidade.
- `address_exists` — o endereço informado corresponde a um endereço reconhecível
  nas fontes; sujeito `organization | person`. Não associa pessoa/empresa ao local.

Combinações inválidas são bloqueadas por `isValidClaimCombination` (matriz
`VALID_CLAIM_SUBJECT_MATRIX`), não aceitas silenciosamente.

### Banco (migração 0022)

- `claim` (RLS FORCE, UNIQUE `(validation_id, type)`, FK `subject_id → subject`,
  `address_id → canonical_address`; sem FK para `validation` — PK composta por
  partição; a exclusão é feita explicitamente na rota de erasure).
- `claim_evidence` (RLS FORCE, FK `claim_id → claim ON DELETE CASCADE`, índices por
  `claim_id` e `(tenant_id, claim_id)`). RLS endurecida: `WITH CHECK` exige que o
  claim pai pertença ao mesmo tenant — tenant A não insere evidência em claim do
  tenant B.
- `signal` **não foi removido**. A relação hoje é `evidence.signal_id` (nullable)
  — cada signal pode ser rastreado a partir da evidência; evidência sem signal é
  permitida explicitamente para o futuro (evidências não derivadas de checker).
- Stance de evidência: `supports | contradicts | unknown`. O `neutral` dos signals
  mapeia para `unknown` na camada de evidência (observação sem posição).

### Assessment sem tabela nova

`validation` já persiste verdict/score/confidence/policy_version/explanation e a
relação é 1:1 com o assessment. **Não criamos tabela `assessment`** — `validation +
claim + evidence` já representam o assessment. Duplicar seria estética arquitetural,
não valor.

### Scoring semanticamente equivalente

`weightedScore` agora recebe as evidências (convertidas de volta para o formato de
signal, com `unknown → neutral`) em vez dos signals. A matemática, a policy e os
vereditos são **idênticos** — a primeira versão da refatoração deve ser um no-op
semântico. A invariante é garantida pelos 109 testes existentes + dataset dourado.

### DTO

`POST /v1/validations` mantém todos os campos e adiciona:

```json
{
  "claim": {
    "id": "...",
    "type": "business_registered_address",
    "subject": { "type": "organization", "id": "<subject_uuid>" },
    "target": { "type": "address", "id": "<address_uuid>" }
  },
  "evidence_summary": { "supporting": 5, "contradicting": 0, "unknown": 2 }
}
```

Evidências completas não são expostas no DTO público (minimização de dados).

### LGPD

O erasure (`DELETE /v1/subjects/:id`) remove claims e evidências junto com
signals/validations — evidência sobre o titular é dado pessoal e deve morrer com
ele. Evidências históricas jamais são sobrescritas: nova observação → nova
evidência (imutabilidade histórica, pré-requisito para a camada de credenciais).

## Por que signal não foi removido

`signal` é a observação bruta do checker; `evidence` é a representação
rastreável vinculada a um claim. Manter os dois permite: (a) migração incremental
sem quebrar consumidores do signal; (b) evidências futuras sem signal; (c) replay
do scoring sem reexecutar checkers. A remoção do signal será avaliada quando o
pipeline estiver 100% no modelo de evidências.

## Como isso prepara para Verifiable Credentials

Uma credencial verificável precisa emitir uma _afirmação_ sobre um _sujeito_ com
_evidências_ verificáveis. O modelo claim/evidence é a assinatura de dados que a
camada SSI consumirá. SSI, DID, wallet, OpenID4VCI/VP, revocation **não fazem
parte desta etapa** — sem o motor de evidências sólido primeiro, credencial seria
embrulho sem conteúdo.

## Alternativas consideradas

- **Colocar claim_type em `validation`** — esconde a relação 1:N futura (múltiplos
  claims por validação, ex. endereço registrado + endereço existe) e o sujeito/alvo.
- **Remover signal e promover evidence** — quebra consumidores e arrisca a
  equivalência semântica exigida.
- **Tabela `assessment`** — duplicação 1:1 de `validation` sem ganho.

## Consequências

- Fast path cria 1 claim + N evidências por validação, na mesma transação
  (idempotência preservada: replay não duplica).
- Batch e webhooks inalterados no contrato; batch agora aceita documentos
  inválidos no lote e os marca `INVALID_DOCUMENT` no processamento (comportamento
  explícito em vez de descarte silencioso na criação).
- Cache Redis revive Buffers serializados (`{type:'Buffer'}` → `Buffer`) — bug
  latente do cache-aside que fazia o segundo request do mesmo CNPJ falhar com 500.
- Migração 0022 não faz backfill: validações históricas ficam sem claim; o
  backfill (1 validation → 1 claim → N evidências) só será executado após
  medir COUNTs, custo e impacto — plano na fase 19.

## Diagrama

```text
Validation
    │
    ▼
Subject
    │
    ▼
Claim ──────────────────────────┐
    │                           │
    ▼                           ▼
Evidence (Receita)      Evidence (CNEFE/CEP/cotenancy...)
    │                           │
    └───────────┬───────────────┘
                ▼
            Assessment (validation: policy + score + confidence + verdict)
                │
                ▼
             Verdict
```
