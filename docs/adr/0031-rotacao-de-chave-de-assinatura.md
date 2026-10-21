# ADR-0031: Rotação de chave de assinatura

## Status

Aceito (2026-10-21). Roadmap #24, etapa 24.2. Complementa o
[ADR-0026](0026-chave-de-assinatura-por-tenant.md) (modelo da chave por tenant),
o [ADR-0029](0029-revogacao-e-expiracao-de-chave-de-assinatura.md)
(`revoked_at` como hard stop) e a etapa 24.1 (`SigningKeyProvider`).

## Contexto

O modelo de estados já existia:

```text
active = true    → chave selecionada para emitir
active = false   → chave SUPERADA: não assina novas, continua publicada
revoked_at       → hard stop (revogação/expiração), separado de `active`
```

E o banco já garantia no máximo **uma chave ativa por tenant** pelo índice
parcial único `issuer_signing_key_active_uq` (`tenant_id WHERE active`), além de
`unique (tenant_id, key_id)`.

Faltava a **operação** de rotação. A troca era feita à mão (dois `UPDATE` em
sequência) pelos testes; não havia atomicidade, serialização entre rotações
concorrentes, nem recusa explícita de reativar uma chave superada. A semântica
estava certa; o lifecycle operacional não.

## Decisão

### 1. A operação é de domínio, não um endpoint

`rotateSigningKey(db, entry, logger)` em
`apps/api/src/services/signing-key-rotation.ts` é a superfície. Não há rota HTTP
nesta etapa: a operação é administrativa (conexão owner, como o provisionamento)
e a aplicação continua só LENDO `issuer_signing_key` e atualizando
`revoked_at` (grants por coluna, ADR-0029). Isso evita novos grants, novos
scopes e uma API pública que ainda não tem contrato no roadmap.

A entrada é um `SigningKeyEntry` (o mesmo de `CREDENTIAL_SIGNING_KEYS`): a
pública publicada é **derivada** do material privado, então não é possível
publicar uma pública que não corresponda ao que o provider vai usar. O material
privado continua só na configuração — sem KMS/HSM nesta etapa.

### 2. `superseded ≠ revoked`

A rotação só escreve `active`:

```text
key A active = true   ──rotate──►  key A active = false   (superada)
                                   key B active = true    (nova)
```

`revoked_at` nunca é tocado. A chave superada continua em
`GET /issuers/:scope`, no DID Document e em `verificationMethod` para as
credenciais antigas. Revogar depois é uma decisão separada e mantém a semântica
do ADR-0029 (hard stop).

### 3. Atomicidade

Tudo em uma transação:

```text
BEGIN
  SET LOCAL lock_timeout = '3s' / statement_timeout = '10s'  -- antes de qualquer lock
  pg_advisory_xact_lock(hash('comprova-signing-key-rotate:' || tenant))
  checagens de conflito/idempotência
  UPDATE ... SET active = false WHERE tenant AND active   -- nunca revoked_at
  INSERT nova chave (active = true)
COMMIT
```

Os timeouts são definidos **antes** da aquisição do advisory lock: `lock_timeout`
vale para qualquer espera de lock, inclusive o advisory lock. Invertendo a
ordem, uma rotação concorrente ficaria esperando sem limite.

Uma falha depois do `UPDATE` (constraint, timeout, erro do chamador) desfaz tudo:
o tenant nunca fica sem chave utilizável nem com duas ativas.

### 4. Concorrência

Duas rotações simultâneas do mesmo tenant são serializadas por um
`pg_advisory_xact_lock` escopado ao tenant (mesmo padrão que o runner de
migrations já usa), com `lock_timeout` definido **antes** da aquisição — a
esfera de espera também tem limite. A segunda espera a primeira commitar e
enxerga o estado novo, então `rotate → rotate` produz
`A superada, B superada, C ativa`, nunca duas ativas.

O índice parcial único é a **segunda barreira**: mesmo que um caminho futuro
esqueça o lock, o banco recusa a segunda ativa. A garantia não é um
`if (active)` na aplicação.

Não há migration: o schema e as constraints já sustentam o lifecycle.

### 5. Conflitos e idempotência

- Rotacionar para a chave que **já é a ativa** (mesmo material) é `unchanged`.
- Reusar um `key_id` publicado com **material diferente** é erro (a chave
  publicada nunca é sobrescrita — a credencial antiga deixaria de verificar).
- Reativar um `key_id` **superado** é erro (não se "ressuscita" uma chave
  aposentada; o caminho é um `key_id` novo).
- Reusar o **material** de outra chave sob um `key_id` novo é erro.

### 6. Emissão e verificação depois da rotação

```text
loadActiveSigningKey()  → key B → SigningKeyProvider → assina com B
proof.verificationMethod → key A → documento público → verifica VC antiga
```

O `SigningKeyProvider` (etapa 24.1) não decide nada: recebe a chave já
selecionada. Rotacionar é decidir **qual** chave está ativa; assinar é outra
responsabilidade.

## Itens deliberadamente NÃO implementados

AWS/GCP/Azure KMS, HSM/CloudHSM/PKCS#11, Vault/OpenBao; rotação automática ou
por cron; endpoint HTTP de rotação; novos scopes; reativação de chave
superada; janela de carência; mudança do formato da VC/`proof`/JCS/DID/status;
migration.

## Testes

- `apps/api/src/services/signing-key-rotation.int.test.ts` — rotação normal,
  `superseded ≠ revoked`, idempotência, duas rotações (A/B superadas, C ativa),
  recusa de reativar superada, recusa de sobrescrever material, recusa de reusar
  material, rollback após falha no meio, lock timeout (row lock e aquisição do
  advisory lock), duas rotações concorrentes sem duas ativas, isolamento entre
  tenants e bootstrap sem chave ativa.
- `apps/api/src/credential.int.test.ts` — rotação pelo caminho real: VC antiga
  continua verificando com A, VC nova sai com `verificationMethod` de B, os
  documentos públicos listam as duas e revogar A depois falha fechado.
