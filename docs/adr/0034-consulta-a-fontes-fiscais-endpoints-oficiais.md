# ADR-0034: Consulta a fontes fiscais apenas por endpoints oficiais resolvidos no servidor

## Status

Proposto (2026-10-22). **Parcialmente implementado em F0.2:** a guarda única de
fetch foi entregue no [ADR-0036](0036-guarda-de-fetch-externo.md); a allowlist
por autorizador e o adaptador NF3e continuam **não implementados**. Pré-requisito
da fase NF3e (F2) e consequência do
[ADR-0033](0033-verificacao-de-evidencias-por-adaptadores.md).

## Contexto

A verificação fiscal recebe do usuário um **QR Code** (ou uma chave de acesso)
que aponta para um portal de autorizador. Esse dado é **controlado pelo
atacante**: o QR pode conter qualquer URL.

O guard anterior era `isSafeWebhookUrl`
(`apps/api/src/modules/webhooks/webhook-crypto.ts`), usado apenas no cadastro de
webhook. Ele verificava `https` e aplicava uma regex de host privado. **Não**
resolvia DNS, **não** validava o IP conectado, **não** limitava tamanho ou
content-type e **não** cobria o momento do envio. Usá-lo como base para consulta
fiscal daria falsa sensação de segurança. Em F0.2 ele foi substituído no envio
por `safeExternalFetch` (ADR-0036), mas a allowlist fiscal continua necessária
porque a guarda genérica não sabe quais autorizadores são legítimos.

A superfície é real: o servidor faria requisições de saída para hosts
influenciados pelo input, exatamente o padrão de SSRF que permite alcançar
metadata de nuvem (`169.254.169.254`), serviços internos e endpoints de
administração.

Além disso, os autorizadores **não são uniformes**. Em 2026-10-22 os
autorizadores de NF3e em produção eram MG, MS, MT, PR, SVRS e SC, com URLs de
consulta diferentes por autorizador; a página de MS apontava o QR para um WSDL.
Assumir uma URL única nacional é incorreto.

## Decisão

1. **A URL do QR nunca é buscada.** Ela serve apenas para **identificar** o
   autorizador e a chave de acesso. A URL de consulta vem de uma **allowlist no
   servidor**, versionada em código, indexada por
   `(tipo de documento, autorizador, ambiente)`.
2. **Se o host do QR não corresponder ao autorizador identificado, não há
   fetch.** O resultado é `unsupported`/`invalid`, com auditoria.
3. **Toda consulta passa pela guarda única `safeExternalFetch`**
   ([ADR-0036](0036-guarda-de-fetch-externo.md)), que:
   - resolve o host e rejeita loopback, RFC1918, link-local, metadata e IPv6
     privado;
   - conecta ao IP validado (proteção contra DNS rebinding);
   - **não segue redirect** (3xx é erro de fonte);
   - aplica timeout, limite de corpo e allowlist de content-type;
   - não aceita credenciais embutidas na URL; o caller não deve enviar cookies
     ou headers de sessão;
   - não executa JavaScript.
4. **Auditoria mínima por consulta:** URL pedida, IP resolvido, status HTTP,
   sha256 da resposta e timestamp. A resposta bruta não vai para log.
5. **Rate limit por tenant e por fonte**, além de cache por chave quando o
   documento for imutável.
6. **A guarda é compartilhada** com o webhook, que já a usa no envio desde F0.2,
   para não existirem duas políticas de saída divergentes.

## Consequências

Positivas:

- Fecha a classe de SSRF antes de existir a primeira fonte externa.
- O cliente não consegue induzir o servidor a buscar host arbitrário.
- A allowlist documenta exatamente quais UFs/autorizadores são suportados.
- A auditoria permite explicar por que uma consulta falhou.

Negativas / custos:

- Exige manutenção da allowlist quando um autorizador muda de URL.
- Exige teste de DNS/IP (inclusive rebinding), que é mais caro que testar regex.
- Uma URL oficial nova só funciona depois de deploy da allowlist — decisão
  consciente (segurança > flexibilidade).
- Não resolve o problema de termos de uso/legalidade da consulta automatizada;
  isso é decisão de produto/jurídico antes de F2.

## Alternativas consideradas

| Alternativa                           | Por que não                                                          |
| ------------------------------------- | -------------------------------------------------------------------- |
| Buscar a URL do QR diretamente        | SSRF direto; o QR é input do atacante                                |
| Reusar `isSafeWebhookUrl`             | Só valida string no cadastro; não resolve DNS nem limita resposta    |
| Allowlist por sufixo de domínio       | Frágil: subdomínio comprometido ou wildcard amplo                    |
| Proxy externo de terceiro             | Adiciona dependência e não elimina a necessidade de validar a origem |
| Confiar no certificado do autorizador | Não impede SSRF; TLS válido não significa host permitido             |

## Fora de escopo

- Implementar a allowlist por autorizador ou o adaptador NF3e. A guarda genérica
  foi entregue em F0.2 (ADR-0036).
- Definir UFs iniciais, cache TTL ou retenção da resposta bruta.
- Consulta SOAP com certificado (avaliar em F2).
- NFAg-e (F7).
