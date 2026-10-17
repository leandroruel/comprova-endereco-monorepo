# ADR-0017: Bindings de verificabilidade (issuer, policy, scorer, evidence-set)

## Status

Aceito (2026-10-17)

## Contexto

A auditoria de verificabilidade do modelo `Validation → Claim → Claim Evidence →
Signal → Evidence` concluiu que o sistema **prova a afirmação para dentro** (é
internamente auditável e reproduzível), mas ainda não **para fora**: uma futura
credencial verificável precisa que a `validation` carregue, ela mesma, os
bindings estáveis da asserção. Faltavam:

- **quem** emitiu (`issuer`) e **sob qual autorização**;
- **qual policy** e **qual implementação de scoring** produziram o resultado;
- um **digest durável** do material de evidência (que é efêmero);
- um **digest determinístico** do conjunto de observações;
- **imutabilidade** da observação histórica.

Esta decisão adiciona somente os **bindings e garantias de domínio** necessários.
Ela **não** implementa DID, VC, JSON-LD, JCS/RFC 8785, assinatura criptográfica,
registry de revogação, selective disclosure, timestamp authority, hash-chain ou
Merkle tree.

## Decisão

### Issuer

`validation.api_key_id uuid` referencia a credencial (`api_key`) que originou a
asserção. A relação é `validation → api_key → tenant`.

- É **nullable**: registros históricos e origens sem api_key (batch) ficam `NULL`.
  Não se atribui credencial arbitrária a registro antigo.
- A coerência de tenant é garantida por **FK composta**
  `(api_key_id, tenant_id) → api_key(api_key_id, tenant_id)` (mesma estratégia de
  `claim → subject`, ADR/0025). Assim `tenant A + api_key de B` é impossível.
- Não se persiste `key_hash`, segredo nem token — apenas o identificador.

### Authority snapshot

`validation.issuer_scopes text[]` é a cópia dos scopes efetivos **no momento da
emissão**. Não depende do estado futuro da api_key (que pode ser revogada ou ter
os scopes alterados) e não armazena segredo. É imutável após a criação.

### Evidence

`evidence` é **material efêmero**: a retenção remove o objeto e anula o ponteiro.

- `claim_evidence.evidence_sha256 bytea` (mesmo tipo de `evidence.sha256`) é o
  **digest histórico/durável** daquele material.
- Regra: quando `claim_evidence.evidence_id` referencia um material,
  `evidence_sha256 = evidence.sha256`. Garantida no runtime (fast/deep) **e** por
  trigger (`claim_evidence_guard_trg`), inclusive para `evidence_id` inexistente.
- Após a retenção: `evidence_id = NULL` e `evidence_sha256` **preservado**.

### Policy

`validation.policy_hash` = `sha256` do **conteúdo efetivo** do YAML carregado
(`policyHashOf`, em `@comprova/core`). Não é hash de caminho, nome de arquivo nem
de objeto JS serializado de forma não canônica.

```text
policy_version + policy_hash  →  identifica o conteúdo da policy usado
```

### Scoring

`validation.scorer_version` = versão explícita da implementação responsável por
transformar sinais em `verdict/score/confidence` (`SCORER_VERSION`, em
`@comprova/core`). Não se usa o commit do git.

### Evidence set

`validation.evidence_set_hash` = `sha256` de uma representação **canônica** do
conjunto de observações (`claim_evidence`) que produziu o resultado.

- Ordena as observações por `claim_evidence_id` (independe da ordem do `SELECT`).
- Serializa cada observação como um array JSON de campos relevantes:
  `[id, checker, checker_version, stance, strength, confidence, source,
observed_at (ISO-8601), evidence_sha256 (hex ou null), detail]`.
- Canonicaliza `detail` recursivamente (chaves ordenadas), pois `jsonb` não
  garante ordem de chaves.
- Usa `evidence_sha256` (durável) e **nunca** `evidence_id` (efêmero): continua
  reproduzível depois que a retenção anula o ponteiro.
- É calculado a partir do **estado persistido** (float4/jsonb já normalizados), de
  modo que o hash gravado é reproduzível a partir do banco.
- O fast path grava o hash do conjunto T0; o deep path o **recomputa** quando o
  veredito final é recalculado. Replay idempotente não recria nem altera nada.

### Imutabilidade

`claim_evidence` representa uma **observação histórica**. Após a criação, são
imutáveis (trigger `claim_evidence_guard_trg`):

```text
claim_evidence_id, tenant_id, claim_id, signal_id, checker, checker_version,
stance, strength, confidence, source, observed_at, ttl_seconds, expires_at,
detail, evidence_sha256, created_at
```

Única exceção permitida, por ser parte da política de retenção já existente:

```text
evidence_id  X → NULL     (com evidence_sha256 preservado)
```

`validation` também tem sua identidade/autoridade/policy imutáveis após a criação
(trigger `validation_identity_guard_trg`): `tenant_id`, `subject_id`,
`api_key_id`, `issuer_scopes`, `policy_version`, `policy_hash`, `scorer_version`,
`created_at`. A evolução legítima do ciclo de vida (`status`, `verdict`, `score`,
`confidence`, `explanation`, `completed_at`, `evidence_set_hash`, `workflow_id`)
permanece livre.

### Onde os valores são determinados

Ponto central: a **persistência do resultado** no fast path (`runFastPath`, dentro
de `withTenant`). Lá são fixados `api_key_id`, `issuer_scopes`, `policy_version`,
`policy_hash`, `scorer_version` e `evidence_set_hash`. O deep path apenas
recomputa `evidence_set_hash` ao recomputar o veredito. A idempotência não muda:
`validation_idempotency PK(tenant_id, idempotency_key)` continua sendo a fonte de
verdade; o replay devolve o estado persistido sem reescrever os bindings.

## Consequências

- Uma `validation` nova responde, a partir do banco, a WHO / WHO-WHAT / WHAT
  EVIDENCE / WHEN / UNDER WHICH POLICY / UNDER WHICH ALGORITHM / WHICH EVIDENCE
  SET, sem depender do objeto físico da evidência.
- A retenção continua idempotente e retry-safe (auditoria anterior), agora
  preservando `evidence_sha256`.
- Campos novos são `nullable` para o histórico — nenhum dado é inventado e nenhum
  backfill destrutivo é executado.
- `batch` passa a gravar `api_key_id = NULL` (antes o `batch_id` era usado como se
  fosse um `api_key`); não há mais identidade sintética.

## Alternativas consideradas

- **Hash de objeto JS da policy**: rejeitado por não ser canônico (ordem de
  chaves, formatação). Usa-se o conteúdo efetivo do YAML.
- **FK simples `validation.api_key_id → api_key`**: rejeitada por não impedir
  `tenant A + api_key de B`. Usa-se FK composta com `tenant_id`.
- **Calcular `evidence_set_hash` em memória**: rejeitado porque `float4`/`jsonb`
  são normalizados pelo PostgreSQL; o hash deve ser calculado do estado
  persistido para ser reproduzível.
- **Bloquear todo `UPDATE` em `claim_evidence`**: rejeitado porque a retenção
  precisa executar `evidence_id X → NULL`; permite-se apenas essa transição.

## Itens deliberadamente não implementados

DID, VC, JSON-LD, JCS/RFC 8785, assinatura Ed25519, chave pública, issuer/subject
DID, registry de revogação, status list, selective disclosure, timestamp
authority/RFC 3161, hash-chain global, Merkle tree e SSI wallet. Serão avaliados
depois que o modelo de domínio estiver preparado (este ADR).
