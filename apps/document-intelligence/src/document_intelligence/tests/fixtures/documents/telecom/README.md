# Documentos de telefonia/internet (reservado)

Este diretório aguarda as primeiras fixtures sintéticas de contas de
telefonia e internet. Conforme decidido na primeira entrega, apenas os tipos
**energia** e **água** possuem fixtures geradas.

Quando adicionar fixtures de telecom, siga a mesma organização:

```text
telecom/
  <uf>/
    telecom-<uf>-<nnn>.pdf
```

e registre o documento em `fixtures/manifests/` e `fixtures/expected/` com
campos compatíveis com o catálogo de manifests.

Não copiar contas reais nem usar logotipos oficiais de concessionárias.
Todos os documentos sintéticos devem conter a marca d'água
`DOCUMENTO FICTÍCIO - TESTE`.
