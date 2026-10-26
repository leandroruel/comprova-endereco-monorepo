# ADR-0042: Força de evidência de fonte externa na policy (F3.1)

## Status

Aceito (2026-10-25)

## Contexto

A F2 materializa a observação fiscal (`claim_evidence`, `source = fiscal_nf3e`,
`checker = nf3e_verification`) com `strength = 0` e `confidence = 0`, sem
`signal`, para que o score e o veredito não mudem antes de existir uma regra
explícita de policy. O [ADR-0041](0041-contrato-fiscal-adapter.md) §3 registra
que "a F3 decide peso, força e eventual hard rule da fonte fiscal"; o
[ADR-0016](0016-claim-evidence-assessment.md) define `evaluateClaim` como a
fronteira única de scoring.

Faltava decidir **como** a força é expressa: números hardcoded no adapter
(proibido), um novo motor de scoring (proibido) ou uma extensão mínima da policy
versionada já existente. Também era preciso evitar que uma única NF3e virasse
três evidências independentes (`document`, `address`, `holder`) e que estados
neutros/indisponíveis ganhassem força negativa.

## Decisão

1. **Extensão mínima e opcional do `PolicySchema`:**

   ```yaml
   evidence_checkers:
     nf3e_verification:
       strength: 0.4
       confidence: 0.8
   ```

   `evidence_checkers` é um mapa `checkerId → { strength, confidence }`. Campo
   opcional com default `{}`: policies já publicadas continuam parseando e o
   `policy_hash` (hash dos bytes do YAML) não muda. Só uma **nova versão** de
   policy pode ativar a regra.

2. **Aplicação no ponto único de scoring.** `evaluateClaim` (via
   `applyPolicyEvidenceStrength`) substitui `strength`/`confidence` da observação
   pelos valores da policy **somente quando `stance = supports`** e o checker
   está configurado. `contradicts` (`differs`), `not_extracted`, `neutral`,
   `inconclusive`, `unavailable` e `unsupported` permanecem sem força: nunca viram
   evidência negativa nem hard rule por este caminho.

3. **Sem dupla contagem.** A evidência continua sendo **uma** observação por
   fonte/checker. `document`/`address`/`holder` já colapsam em um único `stance`
   por `stanceForDimensions`; não há uma linha por dimensão, então a força soma
   uma única vez.

4. **Primeira regra de produção conservadora** em
   `policies/2026.14.1.yaml`: `nf3e_verification` com `strength = 0.4` e
   `confidence = 0.8` (0.32), abaixo de `confirmed_threshold` (0.35) e de
   `conflict_threshold` (0.45) — a NF3e sozinha não confirma nem cria conflito;
   contribui junto das demais evidências. A policy default passa a ser
   `2026.14.1`.

5. **Auditabilidade preservada.** Nenhum YAML existente é editado e não há
   backfill: assessments antigos mantêm `policy_version`/`policy_hash`
   originais. `evidence_checkers` entra no hash da policy nova, então mudar a
   força é uma conclusão nova (C1/ADR-0024), não um replay.

## Alternativas rejeitadas

- **Hardcode no adapter fiscal:** força não pode viver no adapter (ADR-0041);
  policy é o lugar versionado e auditável.
- **Novo peso em `weights`:** `weights` é magnitude aditiva sem
  `confidence`/`stance`; reintroduziria força por peso sem expressar
  `strength × confidence` e "novo peso fiscal" está fora do escopo do slice.
- **Uma evidência por dimensão (`document`/`address`/`holder`):** dupla contagem
  de um único fato; contraria o ADR-0016.
- **`contradicts`/`differs` com força negativa já neste slice:** sem uma regra de
  policy para `differs`, preferimos `unknown`/neutro (conservador).
- **Hard rule fiscal:** decisão de produto posterior; não há base para
  rejeição automática.

## Consequências

Positivas:

- Fonte externa comprovada influencia o assessment existente sem novo pipeline e
  sem tocar `weightedScore`/`bandas`/`hard rules`.
- Força é explícita, versionada e auditável; trocar o valor é uma policy nova.
- Estados inconclusivos/indisponíveis e `differs` permanecem conservadores.

Negativas / débito consciente:

- `matches/matches` só rende força quando o `stance` é `supports`
  (`document = authentic` + `address = matches`). `holder.matches` isolado
  (sem endereço) segue `unknown` porque `stanceForDimensions` exige endereço;
  mudar isso alteraria também F1.3 e fica para depois.
- Com a resposta pública atual da SVRS (apenas `Município`), o endereço fica
  `not_extracted` e a força fiscal tende a não se aplicar na prática.
- O gate de ambiguidade T1/T2 (`decide` sobre signals) não vê observações sem
  `signal`; o simulador de policy (`policy:simulate`) lê `signal`, não
  `claim_evidence`, então ainda não simula esta força.
- O histórico append-only pode manter mais de uma versão do mesmo checker
  (ex.: bump do adapter fiscal). Para scoring, `canonicalStandaloneEvidence`
  (em `deep-enrich.service.ts`, aplicada às observações sem `signal` antes de
  `evaluateClaim`) mantém apenas a observação **mais recente** de cada
  `document_ref_hash` — a leitura vem ordenada por `observedAt DESC,
createdAt DESC` — restrita a `source = fiscal_nf3e` +
  `checker = nf3e_verification`. A versão mais recente prevalece mesmo quando
  o stance muda entre versões (ex.: v1 `supports`, v2 `inconclusive` → só v2
  entra no score, sem força positiva). Todas as linhas históricas são
  preservadas na tabela para auditoria (o hash/explicação usam `readEvidenceSet`
  sem dedup) e evidências não fiscais seguem inalteradas.

## Testes

- `packages/core/src/policy.test.ts`: campo opcional, default `{}`, limites
  `[0, 1]`.
- `packages/core/src/assessment.test.ts`: força só em `supports`; estados
  neutros/contraditórios sem força; contribuição única (0.4 × 0.8 = 0.32);
  no-op sem `evidence_checkers`.
- `apps/worker/src/modules/deep-enrich/deep-enrich.int.test.ts`: NF3e
  `authentic` + `address.matches` soma 0.32 ao score sob `2026.14.1`;
  `not_found`/`invalid`/`inconclusive`/`unavailable`/`unsupported` e `differs`
  não mudam score/veredito.
