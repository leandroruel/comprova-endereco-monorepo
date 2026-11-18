# Manifestos das fixtures sintéticas

Cada documento sintético em `fixtures/documents/` tem um manifesto JSON aqui,
descrivendo origem, emissor, estado, versão de layout, modo de qualidade e os
campos esperados para validação automática.

Formato (exemplo):

```json
{
  "id": "energy-sp-001",
  "arquivo": "documents/energy/sp/energy-sp-001.pdf",
  "tipo": "energia",
  "emissor": "Distribuidora Energia Demo SP",
  "uf": "SP",
  "cidade": "São Paulo",
  "versao_layout": "v1.2",
  "variante": "cabecalho_topo",
  "qualidade": "limpo",
  "formato": "digital",
  "paginas": 1,
  "campos_esperados": [
    "titular",
    "cpf",
    "endereco",
    "cep",
    "cidade",
    "uf",
    "instalacao",
    "codigo_cliente",
    "data_emissao",
    "data_vencimento",
    "consumo",
    "valor"
  ],
  "criado_em": "2026-05-18"
}
```

Campos de `campos_esperados` são os que o harness de avaliação deve tentar
extrair e comparar contra `fixtures/expected/<id>.json`.

Não editar manualmente os PDFs sem atualizar o manifesto correspondente.
