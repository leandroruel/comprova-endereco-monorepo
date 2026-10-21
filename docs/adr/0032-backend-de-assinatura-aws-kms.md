# ADR-0032: Backend de assinatura AWS KMS

## Status

Aceito (2026-10-21). Roadmap #24, etapa 24.3. Complementa o
[ADR-0026](0026-chave-de-assinatura-por-tenant.md) (chave por tenant), o
[ADR-0029](0029-revogacao-e-expiracao-de-chave-de-assinatura.md) (`revoked_at`
como hard stop), o [ADR-0031](0031-rotacao-de-chave-de-assinatura.md) (rotação)
e a etapa 24.1 (`SigningKeyProvider`).

## Contexto

O `SigningKeyProvider` já separava "qual chave o tenant usa" de "assinar bytes",
mas a única implementação lia a privada de `CREDENTIAL_SIGNING_KEYS`. A etapa
24.3 pede um backend AWS KMS **sem** quebrar o provider local e **sem** mudar o
formato das credenciais.

O projeto usa Ed25519 puro com JCS e a cryptosuite `eddsa-jcs-2022`:

```text
hashData   = SHA-256(JCS(proofConfig)) || SHA-256(JCS(document sem proof))
proofBytes = Ed25519(hashData)          # Pure EdDSA
proofValue = multibase-base58btc(proofBytes)
```

A verificação pública resolve a chave pelo `verificationMethod`, lê a pública
do issuer/DID Document e verifica localmente. Nada disso pode passar a depender
da AWS.

## Compatibilidade criptográfica (auditada antes de implementar)

O AWS KMS suporta Ed25519 com:

```text
KeySpec          = ECC_NIST_EDWARDS25519
KeyUsage         = SIGN_VERIFY
SigningAlgorithm = ED25519_SHA_512
MessageType      = RAW
```

`ED25519_SHA_512` é EdDSA puro (FIPS 186-5 §7.6): o KMS recebe a mensagem crua e
produz a assinatura Ed25519 de 64 bytes. É exatamente o que `eddsa-jcs-2022`
espera. A alternativa `ED25519_PH_SHA_512` é HashEdDSA (§7.8), exige
`MessageType: DIGEST` e o KMS ainda aplica o prehash — um hash duplo que o
verificador Pure EdDSA do projeto rejeitaria. Por isso o adaptador fixa
`ED25519_SHA_512` + `RAW` em um único lugar.

Se o KMS não suportasse Ed25519, a decisão seria **parar** e propor a menor
mudança arquitetural (por exemplo, uma segunda cryptosuite ECDSA versionada ou
um HSM com Ed25519), nunca trocar o algoritmo silenciosamente. A compatibilidade
foi confirmada na documentação oficial do KMS antes do código; não houve
necessidade de fallback.

## Decisão

### 1. O KMS assina; a privada nunca chega à aplicação

```text
API ──(hashData)──▶ AWS KMS ──(assinatura)──▶ API
```

A aplicação chama `Sign`, não `GetPrivateKey`, não importa a chave e não usa
envelope/`Decrypt` para reconstruir a privada. Não existe caminho no código para
material privado do KMS em memória.

### 2. A referência externa fica no banco, não o material

A migration `0038_issuer_signing_key_kms_reference.sql` adiciona:

```text
issuer_signing_key.kms_key_reference text NULL
  NULL  → material local em CREDENTIAL_SIGNING_KEYS
  '...' → chave Ed25519 no AWS KMS (ARN canônico)
```

O provisionamento grava o **ARN devolvido pelo `GetPublicKey`**, não o alias de
entrada: um alias pode ser repontado depois, o que trocaria silenciosamente a
chave que assina. O trigger `issuer_signing_key_guard` trata a referência como
identidade imutável, junto de `public_key`/`key_id`/`algorithm`.

O banco continua sendo a autoridade do lifecycle (`active`, `revoked_at`). O KMS
não decide qual tenant pode emitir; a aplicação + RLS + `loadActiveSigningKey`
selecionam a chave e o provider apenas assina com ela. A referência não é
publicada pelos endpoints públicos: issuer/DID documents selecionam colunas
explícitas e nunca devolvem `kms_key_reference`.

### 3. Seleção explícita do backend

```text
SIGNING_KEY_PROVIDER=local     # default; CREDENTIAL_SIGNING_KEYS
SIGNING_KEY_PROVIDER=aws-kms   # chaves Ed25519 no KMS
```

O default continua `local`; KMS nunca vira default silenciosamente. O backend é
global no processo nesta etapa (não por chave). Um tenant cuja chave ativa não
pertence ao backend selecionado falha fechado. O módulo do KMS é importado
dinamicamente só no caminho `aws-kms`, então um boot local não instancia cliente
AWS.

### 4. O provider KMS valida a pública publicada

`SigningKeyRequest` passou a carregar `kmsKeyReference` (o domínio só repassa).
O provider KMS:

1. recusa `null`/vazio como `SIGNING_KEY_UNAVAILABLE`;
2. valida os 32 bytes publicados como Ed25519;
3. envia `hashData` ao KMS;
4. verifica a assinatura devolvida contra a pública do banco;
5. se não validar, falha `SIGNING_KEY_MISMATCH` em vez de emitir uma credencial
   que o verificador não resolveria.

Erros do KMS são traduzidos para `SIGNING_KEY_UNAVAILABLE`; não há fallback para
o provider local.

### 5. Provisionamento e rotação suportam as duas origens

`SigningKeyEntry` virou uma união discriminada:

```text
{ kind: 'local', privateKey }                              # comportamento atual
{ kind: 'kms', kmsKeyReference, publicKey }                # pública já lida do KMS
```

`provisionSigningKeys` e `rotateSigningKey` usam `publicKeyOf`/`kmsKeyReferenceOf`
e persistem a referência. A pública de uma chave KMS é lida com `GetPublicKey`
**apenas** no provisionamento/rotação; a emissão não chama `GetPublicKey`.

Comandos explícitos (sem migração automática de chaves existentes):

```text
pnpm db:provision-kms-key <tenant_id> <key_id> <kms_key_reference>
pnpm db:rotate-kms-key    <tenant_id> <new_key_id> <kms_key_reference>
```

O provisionamento/rotação não altera `SIGNING_KEY_PROVIDER`. Publicar uma chave
KMS e continuar rodando `local` (ou o contrário) faz a emissão falhar fechado
para aquele tenant até o processo da API ser reiniciado com o backend
correspondente. O cutover é explícito, não silencioso.

### 6. Verificação continua independente da AWS

Issuer Document, DID Document, `verificationMethod` e o verificador continuam
usando `issuer_signing_key.public_key` (32 bytes) do banco. O fluxo é:

```text
VC → verificationMethod → issuer/DID document → public key → verificação local
```

Nenhum verificador consulta o KMS.

### 7. Configuração e credenciais

`AWS_KMS_REGION` é opcional; ausente, o SDK usa `AWS_REGION`/default chain. A
região do cliente deve corresponder à região da chave (ou a chave deve ser
multi-região). As credenciais vêm exclusivamente da credential provider chain do
SDK (IAM role, SSO, etc.); não há leitura manual de access key/secret nem
credenciais no `.env.example`.

Permissões mínimas:

- papel da API: `kms:Sign` na chave;
- provisionamento/rotação: `kms:GetPublicKey` na chave;
- nenhum `kms:Decrypt`, nenhuma exportação de chave.

## Consequências

- Chaves locais e credenciais já emitidas continuam funcionando; não há mudança
  de `proof`, `cryptosuite`, DID, `verificationMethod` nem migration de chaves.
- Criar uma chave KMS exige `KeySpec=ECC_NIST_EDWARDS25519`,
  `KeyUsage=SIGN_VERIFY` e a key policy/IAM acima.
- A disponibilidade e a latência do KMS passam a ser dependência da emissão
  (não da verificação). Não há assinatura offline nesse backend.
- O backend global não permite misturar tenants locais e KMS no mesmo processo;
  um provider por chave pode usar a mesma coluna no futuro.
- A rotação continua manual; rotação automática segue fora do escopo. Depois de
  rotacionada, a chave KMS antiga pode ser desativada/agendada para exclusão sem
  afetar a verificação das credenciais antigas: a pública já está no banco e a
  verificação não consulta o KMS.
- Testes de unidade usam um `AwsKmsSigner` fake (assinatura Ed25519 local) e
  verificam que o adaptador envia `RAW`/`ED25519_SHA_512`. Testes de integração
  exercitam persistência da referência, provisionamento/rotação e a imutabilidade
  no Postgres; nenhum teste chama a AWS real.
