# Fase 0 — Relatório de Inspeção

## Pipeline atual (fast path)

```
POST /v1/validations
  │
  ├── middleware: CORS → Helmet → Session (Better Auth) → Auth (API key HMAC) → Rate Limit (Redis)
  │
  ├── intake: isValidDocument() → enrichWithCep() → addressInput from registry or request
  │
  ├── idempotency check: findExistingIdempotency(db, tenantId, key) → replay se existir
  │
  ├── runCheckers(deps, docType, valid, registryRecord, addressRef)
  │     └── Promise.race(checker.run(ctx), timeout(checker.timeoutMs))
  │          └── Signal[] (in-memory)
  │
  ├── weightedScore(signals, policy, now) → score
  ├── decide({signals, score, policy, now}) → verdict, confidence, explanation
  │
  └── withTenant(db, tenantId, tx => {
        INSERT subject (onConflictDoNothing)
        INSERT canonical_address (onConflictDoNothing)
        INSERT validation (verdict, score, confidence, explanation)
        INSERT signal[] (checker_id, checker_version, stance, strength, confidence, source, observed_at, ttl_seconds, detail)
        INSERT outbox (validation.completed)
        INSERT usage_event
        INSERT audit_log
      })
      └── → FastPathResult → DTO
```

## Pontos de inserção identificados

| Ponto                | Onde                                 | O que inserir                            |
| -------------------- | ------------------------------------ | ---------------------------------------- |
| Antes de runCheckers | `fastpath.ts:~290` (após addressRef) | Criar `claim` (1 por validation)         |
| Após runCheckers     | `fastpath.ts:~370` (signals array)   | Transformar cada signal em `evidence`    |
| Na transação         | `fastpath.ts:~400` (tx insert)       | Persistir `claim` + `evidence[]`         |
| No scoring           | `fastpath.ts:~375` (decide call)     | Passar `evidence[]` em vez de `signal[]` |
| No DTO               | `routes/validations.ts`              | Adicionar `claim` + `evidence_summary`   |

## Cardinalidade das relações

```
validation 1:1 claim  (cada validation avalia uma afirmação)
claim     1:N evidence (cada claim tem múltiplas evidências)
evidence  N:1 signal   (cada evidence é produzida por um signal)
```

## Tipo de claim por mode

| Document                        | Tipo                          | Descrição                                       |
| ------------------------------- | ----------------------------- | ----------------------------------------------- |
| CNPJ                            | `business_registered_address` | "Esta organização tem este endereço registrado" |
| CNPJ (sem endereço no registry) | `address_exists`              | "Este endereço existe nas fontes avaliadas"     |
| CPF                             | `address_exists`              | "Este endereço existe nas fontes avaliadas"     |

## Sem incompatibilidade arquitetural. Prosseguindo.
