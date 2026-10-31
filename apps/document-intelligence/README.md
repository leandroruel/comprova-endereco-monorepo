# Document Intelligence

Serviço independente de processamento documental em **Python + [Marker](https://github.com/datalab-to/marker) + FastAPI**.
Recebe um PDF, roda OCR + detecção de layout e devolve um **JSON estruturado e
versionado** para a API do Comprova consumir por HTTP.

- **Não guarda documentos** (arquivo temporário é apagado sempre, inclusive em erro).
- **Não usa LLM** para extração: os processadores `LLM*` do Marker ficam
  desligados (`use_llm=False`). O Marker usa modelos especializados de OCR/layout
  (Surya), não um LLM generalista.
- **Não contém regras fiscais, autenticação ou regra de negócio** — isso continua
  na API/domínio do Comprova.

## Arquitetura

```text
Comprova API (Fastify/TS)
        │  multipart/form-data (PDF)
        ▼
Document Intelligence (FastAPI/Python)
        │
        ▼
Marker 2.1.0  ── OCR + layout + tabelas + leitura (Surya)
        │
        ▼
JSON estruturado (contrato v1.0) ──► API do Comprova
```

O serviço é independente do ciclo de vida da API. A API conversa com ele por
HTTP usando `DOCUMENT_INTELLIGENCE_URL`.

### Fluxo interno de uma requisição

1. Validação de segurança (assinatura `%PDF-`, magic bytes, tamanho, nome do arquivo).
2. Inspeção barata com `pypdfium2` (contagem de páginas, PDF criptografado).
3. Escrita em arquivo temporário aleatório (`mkstemp`) com limpeza garantida.
4. `PdfConverter.build_document` + `JSONRenderer` + `MarkdownRenderer`.
5. Mapeamento para o contrato e remoção do temporário.

## Requisitos

- Python `>=3.10,<4` (recomendado 3.11)
- Dependências de sistema: `poppler-utils`, `libgl1`, `libglib2.0-0`, `libgomp1`,
  fontes (`fonts-liberation`). O `Dockerfile` já instala tudo.
- Pesos do Marker/Surya: baixados na primeira execução para
  `MODEL_CACHE_DIR` (Surya) e `HF_HOME` (Hugging Face).

## Instalação e execução local

Com [uv](https://docs.astral.sh/uv/):

```bash
cd apps/document-intelligence
uv venv .venv
source .venv/bin/activate
uv pip install -e .
# Primeira execução baixa os modelos (~1–2 GB) e aquece o pipeline.
DI_PRELOAD_MODELS=true DI_WARMUP=true python -m document_intelligence
```

Sem `uv`, use `python -m venv .venv` + `pip install -e .`.

### Docker

```bash
# Contexto = este diretório.
docker build -t document-intelligence apps/document-intelligence
docker run --rm -p 8000:8000 \
  -v di-cache:/app/.cache \
  -v di-tmp:/tmp/document-intelligence \
  document-intelligence
```

Ou via `docker compose` (serviço `document-intelligence` no compose raiz).

## Configuração

Todas as variáveis usam o prefixo `DI_`.

| Variável | Default | Descrição |
|---|---|---|
| `DI_HOST` | `0.0.0.0` | Host de escuta |
| `DI_PORT` | `8000` | Porta |
| `DI_LOG_LEVEL` | `info` | `debug`/`info`/`warning`/`error` |
| `DI_LOG_FILE` | — | Arquivo de log opcional (além do stdout JSON) |
| `DI_MAX_FILE_SIZE_MB` | `30` | Tamanho máximo do upload |
| `DI_MAX_CONCURRENCY` | `1` | Requisições admitidas por processo (ver limitações) |
| `DI_TIMEOUT_S` | `300` | Timeout por documento |
| `DI_MAX_PAGES` | — | Limite de páginas; acima disso → HTTP 422 |
| `DI_PRELOAD_MODELS` | `true` | Carrega modelos no startup |
| `DI_WARMUP` | `true` | Roda um PDF sintético no startup para carregar layout/OCR |
| `DI_TEMP_DIR` | — | Diretório dos temporários (default: sistema) |
| `DI_MIN_FREE_MEMORY_MB` | `512` | Mínimo de memória livre para `/ready` |

Cache de modelos (variáveis do Marker/Surya, não `DI_`):

- `MODEL_CACHE_DIR` — pesos do Surya (default `~/.cache/datalab/models`).
- `HF_HOME` — pesos de layout/reconhecimento do Hugging Face.

## Endpoints

### `GET /health`

Responde imediatamente. **Não** carrega modelos.

```json
{"status":"ok","service":"document-intelligence","version":"0.1.0","marker_available":true}
```

### `GET /ready`

Indica se os modelos estão carregados, se o aquecimento terminou e se há memória
suficiente. Retorna `200` com `status: "ready" | "not_ready"`.

### `POST /documents/parse`

`multipart/form-data` com o campo `file` (PDF) e, opcionalmente, `document_id`.

Respostas:

- `200` — contrato completo (`status: "completed"` ou `"failed"` se o Marker falhar).
- `400` — não é PDF, arquivo vazio, nome com path traversal ou PDF corrompido.
- `422` — PDF criptografado ou acima de `DI_MAX_PAGES`.
- `504` — timeout de processamento.
- `500` — erro interno (sem stack trace no corpo).

Exemplo:

```bash
curl -X POST http://localhost:8000/documents/parse \
  -F "file=@fatura.pdf;type=application/pdf" \
  -F "document_id=doc-123"
```

## Contrato JSON (v1.0)

`contractVersion` fica em `metadata.contractVersion`. Campos desconhecidos do
Marker viram `type: "unknown"`, mas texto e `bbox` são preservados.

```json
{
  "documentId": "doc-123",
  "status": "completed",
  "document": {"mimeType": "application/pdf", "pageCount": 2, "sizeBytes": 1137},
  "content": {"text": "...", "markdown": "..."},
  "pages": [
    {
      "pageNumber": 1,
      "width": 612.0,
      "height": 792.0,
      "elements": [
        {
          "id": "/page/0/Text/0",
          "type": "text",
          "text": "CONTRATO DE PRESTACAO DE SERVICOS ...",
          "bbox": {"x1": 68.05, "y1": 58.14, "x2": 418.67, "y2": 107.39},
          "confidence": null,
          "table": null,
          "imageRef": null,
          "metadata": {"blockType": "Text", "sectionHierarchy": {}}
        }
      ]
    }
  ],
  "metadata": {
    "processor": "marker",
    "processorVersion": "2.1.0",
    "processingTimeMs": 1054,
    "contractVersion": "1.0"
  },
  "warnings": []
}
```

> O JSON HTTP usa `camelCase` (aliases do Pydantic). O schema compartilhado em
> `packages/contracts/src/document-intelligence.ts` é a fonte de verdade no
> TypeScript e valida a resposta antes de ela chegar ao domínio.

### Tipos de elemento

`heading`, `text`, `table`, `image`, `list`, `list_item`, `page_header`,
`page_footer`, `code_block`, `formula`, `caption`, `unknown`.

### Tabelas

Quando `type == "table"`, `table` traz:

```json
{
  "headers": ["Item", "Qtd", "Valor"],
  "rows": [["Energia", "10", "100,00"], ["Agua", "5", "50,00"]],
  "cells": [{"text": "Item", "row": 0, "column": 0, "rowspan": 1, "colspan": 1}],
  "bbox": {"x1": 96.86, "y1": 186.98, "x2": 397.88, "y2": 290.42}
}
```

`headers` só é preenchido quando o Marker emite uma linha de cabeçalho (`<th>`).

### `confidence`

O Marker 2.1.0 não expõe confiança por bloco no renderer JSON; por isso o campo
é `null` (previsto no contrato para uso futuro).

## Observabilidade

Logs estruturados em JSON (stdout) com `document_id`, duração, páginas, status,
tipo de erro e versão do Marker. **Nunca** são logados texto extraído, CPF/CNPJ,
endereço ou qualquer conteúdo do documento.

## Desempenho, memória e limitações

Medições reais em CPU (Linux, sem GPU, fixtures de 1–2 páginas):

| Cenário | Tempo |
|---|---|
| PDF com camada de texto (2 páginas) | ~1 s |
| PDF com tabela (1 página, steady state, com OCR) | ~10 s |
| Primeira inferência de layout/tabela (carrega pesos) | ~5 min |
| RAM recomendada no host (modelos + pico de inferência) | 6–8 GB |

> O `sample_table.pdf` dos testes não tem camada de texto: o conteúdo é
> desenhado no PDF, então esse caso exercita o caminho de **OCR** do Marker.

- O **primeiro** documento que usa layout/OCR de tabela carrega pesos e pode
  levar minutos em CPU. Por isso `DI_WARMUP=true` roda um PDF sintético no
  startup (em background). Enquanto isso, `/ready` responde `not_ready`; `/health`
  continua `ok`.
- A inferência local do Marker/Surya **não é thread-safe**: duas inferências
  simultâneas no mesmo processo causam *segfault*. A implementação serializa a
  inferência com um lock. `DI_MAX_CONCURRENCY` limita requisições em fila, mas o
  ganho de paralelismo exige **réplicas do serviço** ou um servidor Surya em GPU
  (`SURYA_INFERENCE_URL`).
- Para produção com volume, prefira GPU (CUDA) ou múltiplas réplicas atrás de um
  load balancer. O `Dockerfile` usa CPU por padrão.
- O serviço não deve ser exposto publicamente sem autenticação/rede interna.

## Testes

```bash
# Rápidos (não baixam modelos): segurança, contrato, fila, parsing de HTML/tabela, API.
pytest -m "not integration"

# Integração real com o Marker (baixa modelos na primeira vez; pode levar minutos).
pytest -m integration
```

Fixtures versionadas em `src/document_intelligence/tests/fixtures/` são PDFs
sintéticos (sem PII), gerados por `generate_fixtures.py`. Os testes de integração
cobrem: PDF de texto multipágina, ordem/numeração/bbox, tabela, contrato e o
endpoint HTTP completo. Testes rápidos cobrem: PDF inválido, vazio, path
traversal, corrompido, limite de páginas, timeout (via HTTP) e parsing de HTML.
