# Documentos sintéticos de comprovante de endereço

Biblioteca versionada de **fixtures sintéticas** usadas para avaliar a extração
de informações por OCR (Tesseract) no serviço `apps/document-intelligence`.

## Objetivo

Avaliar, de forma repetível e sem dados reais, a capacidade do pipeline de
OCR de extrair campos de comprovantes de residência (energia, água e, futuramente,
gás/telecom) sob diferentes layouts, estados (UF), emissores e níveis de
qualidade de impressão/digitalização.

## Estrutura de diretórios

```text
tests/
├── fixtures/
│   ├── documents/          # PDFs sintéticos gerados
│   │   ├── energy/
│   │   │   ├── sp/  rj/  mg/
│   │   │   └── ...
│   │   ├── water/
│   │   │   ├── sp/  rj/  mg/  es/
│   │   │   └── ...
│   │   ├── gas/            # reservado (sem fixtures na primeira entrega)
│   │   └── telecom/        # reservado (sem fixtures na primeira entrega)
│   ├── manifests/          # um JSON por documento (metadados + campos esperados)
│   ├── expected/           # um JSON por documento (valores de verdade-base)
│   └── generate_fixtures.py
├── extraction/
│   ├── __init__.py
│   ├── harness.py          # harness de avaliação (reutilizável)
│   └── test_harness.py     # testes pytest (marcados @integration)
└── ...
```

## Organização dos documentos

Cada documento está organizado por:

1. **Tipo de documento**: `energy`, `water`, `gas`, `telecom`.
2. **Estado (UF)**: `sp`, `rj`, `mg`, `es`…
3. **Emissor**: nome demonstrativo (não é concessionária real).
4. **Versão do layout**: `v1.0`, `v1.1`, `v1.2`, `v1.3`.
5. **Variante de layout**: cabeçalho/topo, coluna esquerda, tabela simples, etc.
6. **Qualidade**: `limpo`, `escaneado`, `baixo_contraste`, `desfocado`, `manchado`, `baixa_resolucao`.

Não se cria um parser independente por estado quando o mesmo emissor usa um
layout compartilhado. A variação de layout fica na variante, não no estado.

## Documentos sintéticos

- Todos são fictícios: nomes, CPF/CNPJ, endereços, CEPs e dados de consumo são
  gerados aleatoriamente (deterministicamente, por semente fixa). **Não são
  dados pessoais reais.**
- Não usam logotipos oficiais de concessionárias.
- Todos contêm a marca d'água visível **`DOCUMENTO FICTÍCIO - TESTE`**.
- Não servem como evidência real de endereço.

Cada documento inclui:

- Nome do titular, CPF fictício, endereço, CEP, cidade, UF.
- Número de instalação/matrícula e código do cliente.
- Identificação do emissor, CNPJ fictício.
- Data de emissão, data de vencimento, mês de referência.
- Informações de consumo (leitura anterior/atual, consumo, tarifa, valor).

## Primeira entrega

| Item                          | Quantidade                            |
| ----------------------------- | ------------------------------------- |
| Fixtures de energia           | 5                                     |
| Fixtures de água              | 5                                     |
| Total de fixtures             | 10                                    |
| Variantes de layout (energia) | 3                                     |
| Variantes de layout (água)    | 3                                     |
| UFs representadas             | SP, RJ, MG, ES                        |
| Formatos                      | PDF digital + PDF escaneado/degradado |
| Manifestos                    | 10 (um por documento)                 |
| Valores esperados             | 10 (um por documento)                 |
| Testes de avaliação           | 32 (integration)                      |

Matriz de cobertura de UFs:

| UF  | Energia | Água | Total |
| --- | ------- | ---- | ----- |
| SP  | 3       | 2    | 5     |
| RJ  | 2       | 1    | 3     |
| MG  | 1       | 1    | 2     |
| ES  | 0       | 1    | 1     |

## Manifestos

Cada manifesto em `tests/fixtures/manifests/<id>.json` declara:

- `id`, `arquivo`, `tipo`, `emissor`, `uf`, `cidade`.
- `versao_layout`, `variante`, `qualidade`, `formato`, `paginas`.
- `campos_esperados`: campos que o harness deve tentar extrair.
- `criado_em`.

A validação automática dos manifestos garante que:

- todo manifesto tem um PDF correspondente;
- todo manifesto tem um arquivo de valores esperados em `tests/fixtures/expected/`;
- todo manifesto declara ao menos um campo esperado.

## Valores esperados

Arquivos em `tests/fixtures/expected/<id>.json` contêm a verdade-base
(ground truth) de cada campo, gerada deterministicamente a partir da mesma
semente usada para criar o PDF. Usados pelo harness de avaliação para medir
taxa de acerto da extração.

## Harness de avaliação

`tests/extraction/harness.py` executa o pipeline real
(`build_parse_response`) sobre cada fixture, extrai os campos do texto
reconhecido e compara com os valores esperados, gerando um relatório em
`tests/fixtures/evaluation_report.json`.

Executar:

```bash
cd apps/document-intelligence
source .venv/bin/activate
pytest -m integration          # exige Tesseract + idioma 'por'
```

Ou apenas o harness:

```bash
pytest src/document_intelligence/tests/extraction/ -m integration -v
```

## Regras respeitadas

- Não usa LLM nem VLM.
- Não usa APIs pagas nem Google Maps.
- Não usa dados pessoais reais.
- Não modifica o banco de dados, API, Worker, scoring nem regras de aprovação.
- Não duplica parsers quando layouts são compartilhados.
- Não gera milhares de PDFs sem necessidade (biblioteca pequena e diversificada).

## Limitações conhecidas

- O Tesseract não detecta tabelas estruturadas; todo texto vira elementos
  `type: "text"`.
- O Tesseract não fornece confiança para camada de texto de PDFs digitais
  (apenas para OCR).
- A extração de campos pelo harness usa heurísticas (regex + rótulo) e não é
  um parser completo; serve como baseline de regressão, não como validação
  final de endereço.
- Documentos com baixa qualidade (baixo contraste, manchado, desfocado,
  baixa resolução) têm taxa de extração menor por projeto: representam casos
  difíceis reais.
- Não há detecção de layout (títulos, figuras) nem recortes de imagem.

## Dívida técnica / segurança

Nenhum problema de segurança crítico identificado nesta entrega. Os documentos
sintéticos contêm CPF/CNPJ fictícios (formato apenas) e não devem ser tratados
como dados pessoais reais.

Sugestão de issue futura: padronizar a extração de campos com expressões
regulares mais robustas e adicionar um parser por emissor (quando houver mais
de um layout por emissor) sem duplicar parsers de estados.
