# ADR-0036: Guarda única de fetch externo seguro

## Status

Aceito e implementado (2026-10-22) — F0.2. A guarda é usada no envio de
webhooks. A allowlist de autorizadores fiscais e o adaptador NF3e continuam
fora desta decisão (ver [ADR-0034](0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)).

Relaciona-se com o [ADR-0011](0011-webhooks-batch-e-sistema.md) (webhooks e
SSRF) e com o [ADR-0034](0034-consulta-a-fontes-fiscais-endpoints-oficiais.md)
(consulta a fontes fiscais).

## Contexto

O servidor faz requisições HTTP para destinos influenciados por input externo:
o cadastro de webhook e, no futuro, a consulta a um autorizador fiscal a partir
de um QR Code. Esse é o padrão clássico de SSRF: uma URL aparentemente pública
pode apontar para loopback, RFC1918, link-local, metadata de nuvem ou um
hostname público que resolve para um IP interno.

Antes de F0.2 existiam duas proteções desconectadas:

- `isSafeWebhookUrl` (`apps/api/src/modules/webhooks/webhook-crypto.ts`) aplicava
  uma regex no **cadastro**. Não resolvia DNS, não validava o IP conectado e não
  olhava redirect, tamanho de resposta ou content-type.
- o publisher do outbox (`apps/api/src/modules/webhooks/outbox-publisher.ts`)
  usava `fetch` global com `redirect: 'manual'` e um `AbortController` de 8 s.
  Não consumia o corpo, não limitava a resposta e não validava o IP efetivamente
  conectado.

A separação entre validação de cadastro e envio permitia que um endpoint
cadastrado como público passasse a resolver para um IP privado depois (DNS
rebinding) e que um redirect levasse a requisição para a rede interna. Também
não havia uma primitiva reutilizável para a fase fiscal.

## Decisão

### 1. Uma única guarda em `packages/providers`

A guarda é `safeExternalFetch`
(`packages/providers/src/safe-fetch/index.ts`), exportada por
`@comprova/providers`. Ela é a única camada de fetch externo iniciado pelo
servidor; callers não recebem opções para desligar protocolo, resolução,
validação de IP, redirect ou limites.

O transporte é `node:https.request`, não um segundo HTTP client. A resolução
DNS usa `node:dns/promises.lookup` com `all: true`, e a classificação de faixas
usa `ipaddr.js` (dependência pequena, sem I/O).

### 2. Somente HTTPS e URL sem credenciais

A URL precisa parsear e usar `https:`. `http:`, `file:`, `ftp:`, `gopher:`,
`data:`, `javascript:` e protocolos desconhecidos falham com
`INVALID_PROTOCOL`. Credenciais embutidas (`user:pass@`) falham com
`CREDENTIALS_IN_URL`. `localhost` e `*.localhost` falham como loopback.

Esse parse síncrono também é exposto como `isSafeExternalUrl` e usado por
`isSafeWebhookUrl` no cadastro. Ele é apenas UX: **não resolve DNS** e não
substitui a guarda no envio.

### 3. Resolver todos os IPs e rejeitar qualquer destino perigoso

Antes da conexão, o hostname é resolvido. Todos os endereços retornados são
validados; se **qualquer** um for perigoso, a requisição inteira falha. Isso
evita respostas DNS mistas (um IP público + um IP privado).

Faixas bloqueadas:

| Faixa                                                                                                  | Motivo          |
| ------------------------------------------------------------------------------------------------------ | --------------- |
| `127.0.0.0/8`, `::1`                                                                                   | `LOOPBACK_IP`   |
| `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`                                                          | `PRIVATE_IP`    |
| `100.64/10` (CGNAT)                                                                                    | `PRIVATE_IP`    |
| `169.254/16`, `fe80::/10`                                                                              | `LINK_LOCAL_IP` |
| `169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`                                 | `METADATA_IP`   |
| `0.0.0.0/8`, multicast, broadcast, documentação, benchmarking, 6to4, Teredo, NAT64 e demais reservadas | `RESERVED_IP`   |

IPv4 mapeado em IPv6 (`::ffff:...`) é convertido para IPv4 e classificado
normalmente.

### 4. DNS rebinding: o IP validado é fixado na conexão

A guarda resolve o hostname **uma vez**, valida a lista e escolhe um endereço
(preferência por IPv4 quando disponível). Esse endereço é devolvido por um
`lookup` customizado passado ao `https.request`; o Node usa essa função em vez
de consultar o DNS novamente. A conexão efetiva, incluindo TLS/SNI, usa o IP já
validado.

O `lookup` devolve sempre o mesmo endereço, mesmo que seja chamado mais de uma
vez pelo runtime. Assim, o cenário:

```text
primeira resolução → IP público
segunda resolução  → 127.0.0.1
```

não acontece. O IP usado na conexão é exposto em `SafeFetchResponse.address`
para auditoria.

O `servername` (SNI) continua sendo o hostname original; para IP literal ele é
omitido. A validação de certificado permanece ligada
(`rejectUnauthorized: true`) e não é configurável pelo caller.

### 5. Redirects não são seguidos

O `https.request` não segue redirect por padrão e a guarda trata qualquer
status `3xx` como `REDIRECT_BLOCKED`. O corpo é drenado e a requisição é
destruída; não há uma segunda conexão para o destino do `Location`.

Não existe opção `redirect: follow`. Se uma integração futura precisar seguir
redirect, cada hop terá que passar novamente pela mesma guarda em uma decisão
explícita.

### 6. Limites independentes do caller

| Limite                       | Default | Faixa permitida     |
| ---------------------------- | ------- | ------------------- |
| timeout total                | 8 s     | 1–15 s              |
| timeout de resolução/conexão | 3 s     | limitado pelo total |
| corpo da resposta            | 256 KiB | 1 KiB–5 MiB         |
| headers da resposta          | 16 KiB  | 4–64 KiB            |
| corpo da requisição          | 1 MiB   | fixo                |
| redirects                    | 0       | não configurável    |

A resolução DNS usa o mesmo orçamento de 3 s e o timeout total começa a contar
antes dela; o tempo restante é usado na conexão e na leitura. A leitura é
incremental. Ao ultrapassar o limite, a guarda falha com `RESPONSE_TOO_LARGE` e
interrompe a leitura; não monta a resposta inteira em memória. Headers acima do
limite falham com `HEADERS_TOO_LARGE`.

Métodos permitidos: `GET`, `POST` e `HEAD`; corpo só em `POST`.

### 7. Content-Type opcional e fail closed

O caller pode informar `allowedContentTypes` (MIME sem parâmetros, comparado
sem case). Se informado e a resposta tiver tipo fora da lista, falha com
`CONTENT_TYPE_NOT_ALLOWED`. Resposta sem `Content-Type` só é aceita se o corpo
for vazio (por exemplo `204`); se houver corpo, falha. Não há sniffing de
conteúdo nesta fase.

### 8. Webhook usa a guarda no envio

`outbox-publisher.ts` não usa mais `fetch` global. Ele chama
`safeExternalFetch` com `POST`, os headers de assinatura e
`allowedContentTypes: ['application/json', 'text/plain']`. O cadastro continua
com `isSafeWebhookUrl` para UX, mas a decisão de segurança acontece no envio.

Consequência deliberada: um receptor que responda `3xx`, corpo acima do limite
ou `Content-Type` fora da allowlist passa a falhar a entrega. Respostas vazias
sem `Content-Type` continuam aceitas.

### 9. Observabilidade sem PII

Falhas da guarda são `SafeFetchError` com `reason` estruturado, `hostname` e
`status` quando aplicável. O webhook registra apenas:

```text
reason, hostname, delivery_id
```

e grava o `reason` em `webhook_delivery.last_error`. Não são registrados URL
completa (path/query), headers, assinatura, corpo, payload, documentos, tokens,
`Authorization` ou PII. O hostname segue as regras de redação existentes.

### 10. Teste sem enfraquecer produção

A instância de produção `safeExternalFetch` não aceita resolver, transporte ou
CA customizados, e a factory `createSafeExternalFetch` **não é reexportada pelo
index do pacote**. Ela existe apenas para o teste de integração com servidor
HTTPS local: injeta um resolver de teste e uma CA autoassinada, mas **toda** a
validação de URL, IP, redirect, limites e content-type continua ativa. O
transporte de teste conecta ao servidor local depois que a guarda já validou um
IP público fictício; a guarda de produção continua rejeitando loopback/RFC1918.

## Consequências

- Webhooks e futuras consultas fiscais compartilham uma primitiva testada, com
  motivos de bloqueio observáveis.
- O envio fica mais estrito: redirect não é seguido e o acknowledgement precisa
  ter tipo de conteúdo permitido (ou corpo vazio).
- A conexão é HTTP/1.1 via `node:https`; não há suporte a proxy, HTTP/2 ou
  credenciais de sessão. Isso é intencional e pode ser revisto com nova decisão.
- A allowlist por autorizador fiscal, o cache, o rate limit por tenant/fonte e
  o parsing do documento continuam em F2/ADR-0034.

## Alternativas consideradas

- **Manter só `isSafeWebhookUrl`**: rejeitada; regex não resolve DNS, não fixa IP
  e não cobre envio.
- **Usar `fetch` global com `redirect: 'manual'`**: rejeitada; `fetch` não expõe
  de forma simples o IP validado para fixar a conexão e não limita o corpo sem
  leitura explícita.
- **Configurar um dispatcher do `undici`**: viável, mas `node:https` dá controle
  direto do `lookup` e evita transformar o dispatcher em superfície de bypass.
- **Seguir redirects validando cada hop**: adiada; não é necessária para webhook
  nem para a primeira versão da consulta fiscal.
