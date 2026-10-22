# ADR-0035: Artefato de evidência tenant-scoped separado do descritor lógico

## Status

Aceito e implementado (2026-10-22) — fundação F0.1. O endpoint de upload, OCR,
consulta fiscal e URLs temporárias **não** fazem parte desta decisão.

Relaciona-se com o [ADR-0016](0016-claim-evidence-assessment.md) (claim/
evidence/assessment), com o [ADR-0033](0033-verificacao-de-evidencias-por-adaptadores.md)
(contrato de verificação) e com o [ADR-0034](0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
(consulta a fontes oficiais).

## Contexto

O Comprova vai receber **documentos reais de clientes/titulares** (comprovantes
de endereço em PDF ou imagem). Esses documentos contêm PII e não podem ser
tratados como o material público capturado no street view.

O modelo existente é:

```text
validation → claim → claim_evidence → assessment → credential
                     ↘ evidence (material opcional)
```

`evidence` é **global**: não tem `tenant_id` nem RLS (`0005_validation.sql`,
`0007_rls.sql`, `0008_grants.sql`). O único escritor hoje é o street view/VLM
(`apps/worker/src/modules/evidence/evidence.service.ts`). Para imagem pública de
fachada isso é adequado — o artefato não é PII e o vínculo com o tenant está em
`claim_evidence`. Para um comprovante de cliente, o artefato **é** dado pessoal.

Era necessário decidir onde o binário/metadados vivem sem:

- transformar `evidence` em container de arquivos de clientes;
- aceitar que um tenant leia/altere/exclua artefato de outro;
- guardar o binário no PostgreSQL;
- criar um segundo sistema de retenção.

## Decisão

### 1. Nova tabela `evidence_artifact`, tenant-scoped

O artefato físico é uma entidade nova, **separada** de `evidence`:

```text
claim
  └── claim_evidence            (observação lógica, tenant-scoped)
          ├── evidence          (descritor material legado, global)
          └── evidence_artifact (objeto bruto, tenant-scoped)
```

`evidence` **não foi alterada**. Ela continua sendo o descritor material usada
pelo street view e por fontes que já materializam naquele pipeline. Novos
documentos de cliente usam `evidence_artifact`; a observação continua em
`claim_evidence` (com o hash durável em `evidence_sha256` quando aplicável).

Campos:

| Campo               | Papel                                                        |
| ------------------- | ------------------------------------------------------------ |
| `artifact_id`       | PK opaca                                                     |
| `tenant_id`         | dono inequívoco; FK para `tenant`                            |
| `claim_evidence_id` | observação à qual o material pertence                        |
| `storage_key`       | chave opaca no object storage (nunca URL pública/presigned)  |
| `content_type`      | MIME declarado (allowlist no serviço; sniffing fica para F1) |
| `size_bytes`        | tamanho em bytes, limitado a 50 MiB                          |
| `sha256`            | digest do conteúdo (32 bytes)                                |
| `created_at`        | criação                                                      |
| `retention_until`   | limite de retenção; a remoção efetiva é feita pelo job       |

### 2. O vínculo é com `claim_evidence`, não com `evidence`

A FK é composta:

```text
(claim_evidence_id, tenant_id)
  → claim_evidence (claim_evidence_id, tenant_id)
```

Isso prova no PostgreSQL que o artefato pertence ao **mesmo tenant** da
observação. Um `INSERT` do tenant A apontando para `claim_evidence` do tenant B
falha no FK — não depende de validação em TypeScript.

Um FK para `evidence` foi deliberadamente **rejeitado**: `evidence` não tem
`tenant_id`; permitir esse vínculo abriria a possibilidade de o tenant A
referenciar material do tenant B. Quando um descritor lógico for necessário para
documentos de cliente, ele deve nascer tenant-scoped, não reutilizar a tabela
global.

### 3. Sem binário no PostgreSQL

O banco guarda **metadados + `storage_key`**. O objeto vive no `ObjectStore` já
existente (`packages/providers/src/object-store.ts`, `put`/`delete`), com a
chave:

```text
tenants/<tenant_id>/evidence/<artifact_id>
```

Não há URL pública permanente. Se URLs de acesso forem necessárias no futuro,
elas serão temporárias e autorizadas (fora desta decisão).

### 4. RLS e grants mínimos

- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`;
- policy `tenant_isolation` com `USING`/`WITH CHECK` em `app_tenant_id()`;
- `GRANT SELECT, INSERT, DELETE` para `app_user`;
- **sem `UPDATE`**: o artefato bruto é write-once; um trigger bloqueia
  `UPDATE` inclusive para admin/owner.

### 5. Integridade e ciclo de vida

- checks de tamanho (1..50 MiB), `sha256` (32 bytes), content-type e
  `storage_key` não vazios;
- check de namespace: `storage_key` precisa começar com
  `tenants/<tenant_id>/evidence/`;
- unique `(tenant_id, storage_key)` para não registrar o mesmo objeto duas vezes
  no tenant;
- FK com `ON DELETE RESTRICT`: nenhum objeto/PII pode virar órfão silencioso. A
  remoção do artefato (objeto primeiro, linha depois) é explícita; só então a
  observação/claim pode ser apagada.

### 6. Retenção integrada ao job existente

`validationRetentionTick` (worker) passou a remover, antes do grafo:

1. o objeto no `ObjectStore` (`store.delete(storage_key)`);
2. a linha em `evidence_artifact`;
3. `claim_evidence` → `claim` → `signal`/`validation_idempotency`/`validation`.

A auditoria `validation.expired` ganhou `artifacts_removed`. Não foi criada uma
política comercial nova: o artefato participa do ciclo da validation. O campo
`retention_until` existe para a política futura (por exemplo, remoção antecipada
ou artefato desacoplado); hoje a retenção efetiva é a da validation.

### 7. Serviço de domínio

`apps/api/src/services/evidence-artifact.ts` concentra:

- `createEvidenceArtifact` — valida allowlist/tamanho, calcula o hash local,
  grava no storage, registra a linha em `withTenant` e **compensa** (apaga o
  objeto) se o INSERT falhar;
- `deleteEvidenceArtifact` — apaga o objeto e só então a linha (retry seguro).

Não há endpoint HTTP nesta entrega.

## Consequências

Positivas:

- PII de cliente deixa de depender de uma tabela global;
- cross-tenant é bloqueado por RLS **e** por FK composta;
- o objeto não fica no banco e pode migrar de provider;
- retenção/erasure não deixam linha sem objeto nem objeto sem linha;
- o street view não sofre regressão.

Negativas / custos:

- existem dois conceitos próximos (`evidence` legado e `evidence_artifact`);
  a documentação precisa deixar a fronteira explícita;
- o par (objeto, linha) não é transacional entre storage e banco; a compensação
  e o retry cobrem a janela, mas uma reconciliação periódica ainda é desejável;
- a remoção do artefato bloqueia a remoção da observação enquanto não for
  executada — comportamento intencional (fail-safe), que exige que erasure e
  retenção usem o serviço/ordem correta;
- `content_type` é declarado; sniffing por conteúdo é F1.

## Alternativas consideradas

| Alternativa                                | Por que não                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `evidence.tenant_id` + RLS                 | Migra tabela populada e mistura material público com PII; regressão no street view |
| `evidence_artifact` com FK para `evidence` | `evidence` é global; permitiria referência cross-tenant                            |
| Binário em `bytea` no PostgreSQL           | Custo, backup, WAL e limites de linha; object storage já existe                    |
| Nova política/job de retenção paralelo     | Duplicaria o mecanismo existente e criaria duas verdades                           |

## Fora de escopo

Upload HTTP/multipart, download, presigned URLs, OCR/VLM, NF3e/NFAg-e, SEFAZ,
QR Code, titular/holder, consentimento, billing, novos scopes, wallet,
OID4VCI/VP e novos scores. Esses itens pertencem às fases seguintes do
[roadmap](../roadmap.md).
