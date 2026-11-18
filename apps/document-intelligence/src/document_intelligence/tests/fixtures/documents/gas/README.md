# Documentos de gás canalizado (reservado)

Este diretório aguarda as primeiras fixtures sintéticas de contas de gás
canalizado. Conforme decidido na primeira entrega, apenas os tipos **energia**
e **água** possuem fixtures geradas.

Quando adicionar fixtures de gás, siga a mesma organização:

```text
gas/
  <uf>/
    gas-<uf>-<nnn>.pdf
```

e registre o documento em `fixtures/manifests/` e `fixtures/expected/` com
campos compatíveis com o catálogo de manifests.

Não copiar contas reais nem usar logotipos oficiais de concessionárias.
Todos os documentos sintéticos devem conter a marca d'água
`DOCUMENTO FICTÍCIO - TESTE`.
