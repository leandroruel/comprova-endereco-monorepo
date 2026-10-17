# ADR-0018: Fechamento do grafo da asserção (actor de batch e imutabilidade)

## Status

Aceito (2026-10-17)

## Contexto

Revisão crítica de [ADR-0017](0017-verifiability-bindings.md) / migrations
`0028`–`0029`. A revisão confirmou que os bindings de verificabilidade já estão
corretos e completos: issuer (`api_key_id` + `issuer_scopes` + FK composta),
policy/scorer (`policy_hash` + `scorer_version`), digest durável do material
(`claim_evidence.evidence_sha256`) e digest determinístico do conjunto
(`validation.evidence_set_hash`). Restaram dois pontos:

1. **Actor de origem batch.** Ao remover a identidade sintética (`api_key_id =
batch_id`), `0028` deixou validações de batch com `api_key_id = NULL` **e**
   `user_id = NULL`. A pergunta "qual actor/autorização produziu esta asserção?"
   só era respondível por um lookup reverso `validation → batch_item → batch`
   (sem índice e sem FK, porque `validation` é particionada).

2. **Grafo da asserção não era totalmente imutável.** `0028` protegeu
   `claim_evidence` e a identidade/autoridade/policy da `validation`, mas a
   própria asserção (`claim`) e os campos `validation.validation_id` /
   `validation.legal_basis` ficaram sem proteção contra `UPDATE` silencioso.

## Decisão

### Actor de batch

O `batch.user_id` (a sessão que criou o lote) é propagado para
`validation.user_id` no processamento do lote. Não se cria credencial nem
identidade nova: usa-se a coluna que já existe (`0020`) e a autorização que já
existe (`batch.user_id`, `0021`). Assim toda `validation` responde ao "quem":

- origem interativa → `api_key_id` + `issuer_scopes`;
- origem batch → `user_id` (api_key legítima/ausente, `NULL`).

### Imutabilidade (migration `0030`)

Completa-se a Opção B (bloquear reescrita) do ADR-0017 para todo o grafo:

- `validation_identity_guard` passa a incluir `validation_id` e `legal_basis`;
- novo `claim_immutability_guard_trg` bloqueia `UPDATE` em `claim`.

`DELETE` **não** é bloqueado: continua sendo a operação legítima da retenção e
do direito de eliminação (LGPD). A evolução de ciclo de vida da `validation`
(`status`, `verdict`, `score`, `confidence`, `explanation`, `completed_at`,
`evidence_set_hash`, `workflow_id`) e a desvinculação de material expirado
(`claim_evidence.evidence_id → NULL`) permanecem livres.

Nenhum caminho de produção faz `UPDATE` em `claim`, `validation.validation_id`
ou `validation.legal_basis`; as travas são defensivas e não alteram
comportamento.

## Itens deliberadamente NÃO implementados

- Identificador portável de subject (DID). `subject_id` + `doc_hmac` + `doc_type`
  já formam referência interna estável; um identificador portável só é
  necessário no momento da emissão da credencial.
- Tabela `assertion` paralela. `claim` já é a asserção de domínio.
- Assinatura criptográfica, JCS/RFC 8785, timestamp authority/RFC 3161, registry
  de revogação/status list, hash-chain/Merkle, selective disclosure, wallet.
- Versionamento (`Option D`) ou event sourcing (`Option C`) do grafo: a
  observação já é imutável (append-only por linha) e a evolução da asserção é
  capturada pela evolução de `validation`, sem necessidade de log de eventos
  próprio.

## Consequências

- A `validation` responde a WHO / WHO-WHAT / WHAT / WHAT EVIDENCE / WHEN /
  UNDER WHICH POLICY / UNDER WHICH ALGORITHM / WHICH EVIDENCE SET para todas as
  origens (interativa e batch), a partir do banco.
- O grafo `validation → claim → claim_evidence` é imutável contra reescrita
  silenciosa, mantendo a retenção e a LGPD intactas.
- Nenhuma coluna foi removida, nenhum dado histórico foi inventado/backfillado e
  nenhuma política de retenção foi alterada.
