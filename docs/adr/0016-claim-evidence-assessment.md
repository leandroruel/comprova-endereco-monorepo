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

conceitos e nomes canônicos (evitando a confusão `evidence` × `claim_evidence`):

- **signal** — observação **bruta** produzida por um checker durante uma execução.
  Persistida em `signal`; por si só não está vinculada a um claim.
- **claim** — a afirmação que se tenta estabelecer (ex.: "a organização X possui o
  endereço registrado Y"). Identidade opaca (`claim_id`), sujeito (`subject_id`) e
  alvo (`address_id`) referenciados por UUID internos (nunca CPF/CNPJ em claro).
- **claim_evidence** — **observação persistida de um checker, vinculada a um claim**
  (checker + versão + fonte + stance + força + confiança + observação + TTL +
  detalhe). É o elo `claim → claim_evidence → signal`. O identificador próprio é
  `claim_evidence_id` (o nome `evidence_id` é reservado ao artefato material).
- **evidence** — **artefato material** capturado de uma fonte (documento, imagem,
  snapshot, payload externo): `kind`, `provider`, `s3_uri`, `sha256`, retenção. É
  **diferente** de `claim_evidence`: um `country_check` produz `claim_evidence`
  **sem** artefato; um `street_view_vlm` pode produzir `claim_evidence` **com**
  `evidence_id`. O vínculo `claim_evidence.evidence_id → evidence` é **opcional**.
- **assessment** — a conclusão de avaliar o conjunto de `claim_evidence` de um
  claim contra uma policy (veredito, score, confiança, explicação). Não possui
  tabela própria: `validation` persiste o resultado do assessment.

### Tipos de claim (fase 1)

- `business_registered_address` — sujeito `organization` (CNPJ com endereço de
  registro). Não afirma funcionamento físico nem legitimidade.
- `address_exists` — o endereço informado corresponde a um endereço reconhecível
  nas fontes; sujeito `organization | person`. Não associa pessoa/empresa ao local.

Combinações inválidas são bloqueadas por `isValidClaimCombination` (matriz
`VALID_CLAIM_SUBJECT_MATRIX`), não aceitas silenciosamente.

### Banco (migrações 0022 e 0023)

- `claim` (RLS FORCE, UNIQUE `(validation_id, type)`, FK `subject_id → subject`,
  `address_id → canonical_address`; sem FK para `validation` — PK composta por
  partição; a exclusão é feita explicitamente na rota de erasure).
- `claim_evidence` (RLS FORCE, PK `claim_evidence_id`, FK `claim_id → claim
ON DELETE CASCADE`, FK `evidence_id → evidence` **opcional**, índices por
  `claim_id`, `(tenant_id, claim_id)` e `evidence_id` parcial). RLS endurecida:
  `WITH CHECK` exige que o claim pai pertença ao mesmo tenant — tenant A não insere
  evidência em claim do tenant B.
- **Migração 0023 — desambiguação `evidence` × `claim_evidence`.** O PK de
  `claim_evidence` chamava-se `evidence_id`, colidindo com `evidence.evidence_id`
  (artefato material) e tornando ambíguo `signal.evidence_id`. A 0023 renomeia o PK
  para `claim_evidence_id`, adiciona `claim_evidence.evidence_id` (FK opcional →
  `evidence`) e adiciona a FK `claim.address_id → canonical_address` (garantindo o
  alvo do claim). O `signal.evidence_id` passa a ter **uma única semântica**:
  referencia apenas artefato material (`evidence`); no fast path (T0) é **nulo**.
- `signal` **não foi removido**. A relação canônica `signal → claim_evidence` é
  feita por `claim_evidence.signal_id` (nullable) — o `signal` é a observação bruta
  que origina a `claim_evidence`; `claim_evidence` sem `signal` é permitida
  explicitamente para o futuro (observações não derivadas de checker). Essa coluna
  **não** tem FK: o PK de `signal` é composto `(signal_id, created_at)` e não há
  UNIQUE apenas em `signal_id`; a ligação é lógica, garantida pela pipeline.
- Stance de evidência **persistida**: `supports | contradicts | unknown`. O `neutral`
  dos signals mapeia para `unknown` no momento da gravação (observação sem posição).
  Em memória, porém, a evidência preserva o stance fiel do signal (inclui `neutral`)
  para manter o scoring idêntico — ver "Scoring semanticamente equivalente".

### Assessment sem tabela nova

`validation` já persiste verdict/score/confidence/policy_version/explanation e a
relação é 1:1 com o assessment. **Não criamos tabela `assessment`** — `validation +
claim + evidence` já representam o assessment. Duplicar seria estética arquitetural,
não valor.

### Scoring semanticamente equivalente (Fase 10)

O scoring passa a ser exposto por uma função explícita de domínio:

```ts
evaluateClaim({ claim, evidence, policy, now }): { score, decision }
```

`evaluateClaim` (em `packages/core/src/assessment.ts`) reconstrói os signals a
partir das evidências e delega para `weightedScore` + `decide`. É a fronteira
única de scoring: fast path e deep path a usam em vez de chamarem o scorer
diretamente.

Invariante de compatibilidade — **fidelidade de stance**. O `decide` distingue
`neutral` de `unknown` (em `confidenceFrom`, um checker `neutral` conta como
"respondeu"; `unknown` não). Para que a reconstrução seja idêntica ao pipeline de
signals, o `stance` da evidência **em memória** espelha fielmente o do signal
(inclui `neutral`); o colapso `neutral → unknown` acontece **apenas na
persistência** (enum de 3 valores). Sem isso, a confidence mudaria em casos como
`SHARED_VIRTUAL` (cotenancy `neutral`).

A matemática, a policy e os vereditos são **idênticos** — a primeira versão da
refatoração é um no-op semântico. A invariante é garantida por
`packages/core/src/evaluate.test.ts` (OLD `weightedScore`+`decide` vs NEW
`evaluateClaim`, inclui `neutral != unknown`), pelos testes de scoring/assessment
existentes e pelo dataset dourado.

### Teste diferencial OLD vs NEW (Fase 11)

Além do teste unitário de equivalência, um teste de integração ponta-a-ponta
(`apps/api/src/golden.int.test.ts`) prova a equivalência **classe a classe** do
dataset dourado: para cada caso, ele lê a validação persistida (caminho NEW, via
`evaluateClaim`) e **recomputa** o caminho OLD (`weightedScore` + `decide`) a
partir dos `signal` brutos relidos do banco, comparando veredito, score
(`tanh`), confidence e explicação. Como o `signal` preserva o stance de 4
valores (`neutral` inclusive), o recompute usa exatamente a mesma entrada que o
pipeline usou. Qualquer divergência (ex.: colapso indevido de `neutral`) faz o
teste falhar.

### DTO

Tanto `POST /v1/validations` quanto `GET /v1/validations/:id` (e o replay
idempotente) mantêm todos os campos e adicionam, de forma aditiva e opcional:

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

### Explicação estruturada (Fase 13)

`validation.explanation` (string) permanece no DTO para compatibilidade. Além
dele, o pipeline agora constrói um `AssessmentExplanation`
(`buildAssessmentExplanation` em `packages/core`) e persiste a forma estruturada
no mesmo jsonb:

```json
{
  "summary": "…",
  "code": "CONFIRMED_COMMERCIAL",
  "supporting_evidence": ["<evidence_id>", "…"],
  "contradicting_evidence": ["<evidence_id>"]
}
```

O DTO público expõe um campo adicional opcional `explanation_detail`:

```json
{
  "explanation": "…",
  "explanation_detail": {
    "code": "CONFIRMED_COMMERCIAL",
    "message": "…",
    "supporting_evidence": ["…"],
    "contradicting_evidence": []
  }
}
```

Decisões:

- `code` é o veredito, para consumo programático sem parsear linguagem natural;
- os ids referenciam `claim_evidence` (não `signal`), preservando a
  rastreabilidade evidence → claim;
- `explanation` (string) nunca é removido — a mudança é aditiva;
- o **deep path** agora também cria/reusa o claim e grava `claim_evidence` por
  sinal T1/T2, então preenche `explanation_detail` igual ao fast path
  (ver "Deep path" abaixo).

### Deep path

`deepEnrich` passou a completar a trilha claim/evidence das validações
`deep`/`auto`:

- **reusa** o claim criado pelo fast path (ou cria um, se a validação é legada
  ou veio de fora do fast path); a unicidade `(validation_id, type)` evita
  duplicatas concorrentes;
- garante, de forma idempotente, uma `claim_evidence` por **signal** da validação:
  anexa as novas (T1/T2) e **faz backfill** das pré-existentes ainda sem observação
  (validações legadas, criadas antes do modelo), ligando
  `claim_evidence.signal_id → signal.signal_id` (rastreabilidade
  claim → claim_evidence → signal → checker);
- deduplica por `checker@version` (mesma regra dos signals), então replay não
  duplica evidências;
- reconstrói `explanation_detail` a partir de **todas** as `claim_evidence` do
  claim (T0 + T1/T2).

Nota: `signal.evidence_id` referencia **apenas** artefato material (`evidence`) —
no caso VLM, aponta para a imagem/snapshot em S3; no fast path (T0) é nulo. A
ligação observação↔claim é sempre `claim_evidence.signal_id`; a FK
`claim_evidence.evidence_id` propaga o artefato material do checker (quando
existe). Ambas as semânticas foram desambiguadas na migração 0023.

### LGPD

O erasure (`DELETE /v1/subjects/:id`) remove claims e evidências junto com
signals/validations — evidência sobre o titular é dado pessoal e deve morrer com
ele.

### Imutabilidade histórica (Fase 14)

Evidências são **append-only**: uma nova observação gera uma nova evidência, jamais
sobrescreve uma existente. O teste `apps/worker/src/deep-enrich.int.test.ts`
(“Fase 14 — claim_evidence é append-only e imutável entre execuções”) comprova, com
snapshot das linhas de `claim_evidence`:

1. o enriquecimento T1 **anexa** novas evidências sem alterar as do fast path
   (cada linha pré-existente permanece byte-a-byte idêntica);
2. **replay** (nova execução) não muta nem duplica as evidências já persistidas
   (dedup por `checker@version` → nenhuma inserção);
3. nunca há `claim_evidence_id` duplicado.

A imutabilidade é pré-requisito para a camada de credenciais (uma credencial não
pode referenciar evidência mutável).

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
Claim ────────────────────────────┐
    │                             │
    ▼                             ▼
Claim Evidence (Receita)   Claim Evidence (CNEFE/CEP/cotenancy...)
    │                             │
    │                             ├──(opcional)─▶ Evidence (artefato material/S3)
    └───────────┬─────────────────┘
                ▼
            Assessment (validation: policy + score + confidence + verdict)
                │
                ▼
             Verdict
```
