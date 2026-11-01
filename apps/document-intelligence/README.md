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

0. **Admissão** (middleware): capacidade `DI_MAX_CONCURRENCY + DI_MAX_QUEUE`;
   excedente → `429` **antes de ler o upload**. O slot só é liberado quando a
   thread de inferência termina (inclusive em timeout/cancelamento).
1. Validação de segurança (assinatura `%PDF-`, magic bytes, tamanho, nome do arquivo).
2. Inspeção barata com `pypdfium2` (contagem de páginas, PDF criptografado,
   limite `DI_MAX_PAGES`) — **antes** de qualquer inferência.
3. Escrita em arquivo temporário aleatório (`mkstemp`) com limpeza garantida.
4. `PdfConverter.build_document` + `JSONRenderer` + `MarkdownRenderer`.
5. Mapeamento para o contrato (incluindo recortes de imagem com teto de bytes)
   e remoção do temporário.

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
uv sync --extra dev   # dependências de teste (pytest etc.)
# Primeira execução baixa os modelos (~1–2 GB) e aquece o pipeline.
DI_PRELOAD_MODELS=true DI_WARMUP=true python -m document_intelligence
```

Sem `uv`, use `python -m venv .venv` + `pip install -e ".[dev]"`.

### Docker

```bash
# Contexto = este diretório.
docker build -t document-intelligence apps/document-intelligence
docker run --rm -p 8000:8000 \
  -v di-cache:/app/.cache \
  -v di-tmp:/tmp/document-intelligence \
  document-intelligence
```

Ou via `docker compose` na raiz — o serviço é **opt-in** (perfil dedicado) para
não pesar o stack padrão:

```bash
docker compose --profile document-intelligence up -d document-intelligence
```

O `Dockerfile` já embute o `llama-server` (llama.cpp, CPU), backend de OCR do
Marker/Surya para PDFs escaneados. Em produção com GPU, aponte
`SURYA_INFERENCE_URL` para um servidor de inferência dedicado.

## Configuração

Todas as variáveis usam o prefixo `DI_`.

| Variável                   | Default   | Descrição                                                   |
| -------------------------- | --------- | ----------------------------------------------------------- |
| `DI_HOST`                  | `0.0.0.0` | Host de escuta                                              |
| `DI_PORT`                  | `8000`    | Porta                                                       |
| `DI_LOG_LEVEL`             | `info`    | `debug`/`info`/`warning`/`error`                            |
| `DI_LOG_FILE`              | —         | Arquivo de log opcional (além do stdout JSON)               |
| `DI_MAX_FILE_SIZE_MB`      | `30`      | Tamanho máximo do upload                                    |
| `DI_MAX_CONCURRENCY`       | `1`       | Slots de processamento (inferência é serializada)           |
| `DI_MAX_QUEUE`             | `2`       | Requisições admitidas aguardando o worker; excedente → 429  |
| `DI_TIMEOUT_S`             | `300`     | Timeout por documento                                       |
| `DI_MAX_PAGES`             | `100`     | Limite de páginas aplicado antes da inferência; acima → 422 |
| `DI_INCLUDE_IMAGES`        | `true`    | Embute recortes de imagem como data URL                     |
| `DI_MAX_IMAGE_BYTES`       | `262144`  | Teto por imagem embutida (256 KiB)                          |
| `DI_MAX_TOTAL_IMAGE_BYTES` | `2097152` | Teto total de imagens por documento (2 MiB)                 |
| `DI_PRELOAD_MODELS`        | `true`    | Carrega modelos no startup                                  |
| `DI_WARMUP`                | `true`    | Roda um PDF sintético no startup para carregar layout/OCR   |
| `DI_TEMP_DIR`              | —         | Diretório dos temporários (default: sistema)                |
| `DI_MIN_FREE_MEMORY_MB`    | `512`     | Mínimo de memória livre para `/ready`                       |

A capacidade de admissão é `DI_MAX_CONCURRENCY + DI_MAX_QUEUE`. Acima disso o
serviço responde `429` **antes de ler o corpo do upload** — não existe fila
ilimitada nem acúmulo de PDFs inteiros em memória.

Cache de modelos (variáveis do Marker/Surya, não `DI_`):

- `MODEL_CACHE_DIR` — pesos do Surya (default `~/.cache/datalab/models`).
- `HF_HOME` — pesos de layout/reconhecimento do Hugging Face.

## Endpoints

### `GET /health`

**Liveness.** Responde `200` imediatamente enquanto o processo está vivo. **Não**
carrega modelos nem depende de warmup — pode responder `200` durante o
carregamento.

```json
{ "status": "ok", "service": "document-intelligence", "version": "0.1.0", "marker_available": true }
```

### `GET /ready`

**Readiness.** Retorna `200` **somente** quando modelos carregados, warmup
concluído (se habilitado) e memória livre ≥ `DI_MIN_FREE_MEMORY_MB`. Caso
contrário retorna **`503`** com `status: "not_ready"` no corpo.

```json
{
  "status": "not_ready",
  "service": "document-intelligence",
  "version": "0.1.0",
  "models_loaded": false,
  "checks": { "marker_modelos": "não carregados", "aquecimento": "em andamento" }
}
```

Orquestradores devem usar `/ready` para decidir roteamento e `/health` apenas
para reiniciar o processo. O `docker-compose.yml` usa `/ready` no healthcheck
(readiness); o `Dockerfile` mantém `HEALTHCHECK` de liveness em `/health`.

### `POST /documents/parse`

`multipart/form-data` com o campo `file` (PDF) e, opcionalmente, `document_id`.

Respostas:

- `200` — contrato completo (`status: "completed"` ou `"failed"` se o Marker falhar).
- `400` — não é PDF, arquivo vazio, nome com path traversal ou PDF corrompido.
- `413` — upload acima de `DI_MAX_FILE_SIZE_MB` (aborta a leitura no limite).
- `422` — PDF criptografado ou acima de `DI_MAX_PAGES` (inspeção prévia,
  sem inferência).
- `429` — capacidade esgotada (`DI_MAX_CONCURRENCY + DI_MAX_QUEUE`), com
  `Retry-After: 5`. A rejeição acontece antes de o upload ser lido.
- `504` — timeout de processamento (o slot continua ocupado até a thread terminar).
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
  "document": { "mimeType": "application/pdf", "pageCount": 2, "sizeBytes": 1137 },
  "content": { "text": "...", "markdown": "..." },
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
          "bbox": { "x1": 68.05, "y1": 58.14, "x2": 418.67, "y2": 107.39 },
          "confidence": null,
          "table": null,
          "imageRef": null,
          "metadata": { "blockType": "Text", "sectionHierarchy": {} }
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
  "rows": [
    ["Energia", "10", "100,00"],
    ["Agua", "5", "50,00"]
  ],
  "cells": [{ "text": "Item", "row": 0, "column": 0, "rowspan": 1, "colspan": 1 }],
  "bbox": { "x1": 96.86, "y1": 186.98, "x2": 397.88, "y2": 290.42 }
}
```

`headers` só é preenchido quando o Marker emite uma linha de cabeçalho (`<th>`).

### Imagens (`type: "image"`)

O Marker detecta `Picture`, `Figure`, `Diagram`, `PictureGroup`, `FigureGroup`,
`ChemicalBlock`, `ComplexRegion` e `Handwriting`. Página e `bbox` são sempre
preservados.

Quando o renderer JSON do Marker fornece o recorte (`JSONBlockOutput.images`),
o serviço o embute em `imageRef` como **data URL** (`data:image/jpeg;base64,...`),
com dois tetos configuráveis:

- `DI_MAX_IMAGE_BYTES` (default 256 KiB) por imagem;
- `DI_MAX_TOTAL_IMAGE_BYTES` (default 2 MiB) por documento.

```json
{
  "id": "/page/0/Picture/1",
  "type": "image",
  "bbox": { "x1": 28.2, "y1": 28.2, "x2": 269.7, "y2": 271.2 },
  "imageRef": "data:image/jpeg;base64,/9j/4AAQSk...",
  "metadata": {
    "blockType": "Picture",
    "imageExtracted": true,
    "imageBytes": 19740,
    "imageMimeType": "image/jpeg"
  }
}
```

Sem extração a representação é **honesta** — nunca há referência fictícia:

| Situação                             | `imageRef` | `metadata.imageSkippedReason`       |
| ------------------------------------ | ---------- | ----------------------------------- |
| Recorte extraído e dentro dos tetos  | data URL   | —                                   |
| Recorte maior que os tetos           | `null`     | `size_limit` (+ item em `warnings`) |
| Tipo de imagem sem recorte confiável | `null`     | `not_available`                     |
| `DI_INCLUDE_IMAGES=false`            | `null`     | `disabled`                          |

Nada é persistido: os recortes existem apenas na resposta daquela requisição.
Para desligar o conteúdo binário (payload menor), use `DI_INCLUDE_IMAGES=false`.

### `confidence`

O Marker 2.1.0 não expõe confiança por bloco no renderer JSON; por isso o campo
é `null` (previsto no contrato para uso futuro).

## Observabilidade

Logs estruturados em JSON (stdout) com `document_id`, duração, páginas, status,
tipo de erro e versão do Marker. **Nunca** são logados texto extraído, CPF/CNPJ,
endereço ou qualquer conteúdo do documento.

## Desempenho, memória e limitações

Medições reais em CPU (Linux, sem GPU, fixtures de 1–2 páginas):

| Cenário                                                | Tempo  |
| ------------------------------------------------------ | ------ |
| PDF com camada de texto (2 páginas)                    | ~1 s   |
| PDF com tabela (1 página, steady state, com OCR)       | ~10 s  |
| Primeira inferência de layout/tabela (carrega pesos)   | ~5 min |
| RAM recomendada no host (modelos + pico de inferência) | 6–8 GB |

> O `sample_table.pdf` dos testes não tem camada de texto: o conteúdo é
> desenhado no PDF, então esse caso exercita o caminho de **OCR** do Marker.

- O **primeiro** documento que usa layout/OCR de tabela carrega pesos e pode
  levar minutos em CPU. Por isso `DI_WARMUP=true` roda um PDF sintético no
  startup (em background). Enquanto isso, `/ready` responde `not_ready`; `/health`
  continua `ok`.
- A inferência local do Marker/Surya **não é thread-safe**: duas inferências
  simultâneas no mesmo processo causam _segfault_. A implementação serializa a
  inferência com um lock. `DI_MAX_CONCURRENCY` limita requisições em fila, mas o
  ganho de paralelismo exige **réplicas do serviço** ou um servidor Surya em GPU
  (`SURYA_INFERENCE_URL`).
- **Admissão**: a capacidade total é `DI_MAX_CONCURRENCY + DI_MAX_QUEUE`
  (default `1 + 2`). O excedente recebe `429` com `Retry-After` **antes** de o
  corpo ser lido; não há fila ilimitada. Em timeout (`504`) o slot permanece
  ocupado até a thread de inferência terminar, e o mesmo vale para cancelamento
  do cliente — a capacidade nunca é liberada com trabalho ainda em execução.
- **Limite de páginas**: `DI_MAX_PAGES` (default `100`, sem modo "ilimitado")
  é verificado com `pypdfium2` **antes** de chamar o Marker; PDFs acima do
  limite retornam `422` sem nenhuma inferência.
- **Imagens**: os recortes são embutidos apenas se o renderer JSON do Marker os
  fornecer e se couberem nos tetos (`DI_MAX_IMAGE_BYTES`,
  `DI_MAX_TOTAL_IMAGE_BYTES`). Recortes acima do teto ficam sem `imageRef`
  (`imageSkippedReason: "size_limit"` + warning). Não há OCR específico de QR
  Code, endpoint separado de imagem nem armazenamento — o recorte viaja na
  própria resposta.
- **Healthcheck**: o Compose aceita um único `healthcheck` por serviço. O
  Compose usa `/ready` (readiness, com `start_period` de 15 min para o warmup
  em CPU) e o `Dockerfile` mantém `HEALTHCHECK` em `/health` (liveness).
- Para produção com volume, prefira GPU (CUDA) ou múltiplas réplicas atrás de um
  load balancer. O `Dockerfile` usa CPU por padrão.
- O serviço não deve ser exposto publicamente sem autenticação/rede interna.

## Testes

```bash
cd apps/document-intelligence
source .venv/bin/activate   # ou: uv sync --extra dev (ver Instalação)

# Rápidos (não baixam modelos): segurança, contrato, fila, parsing de HTML/tabela, API.
pytest -m "not integration"

# Integração real com o Marker (baixa modelos na primeira vez; pode levar minutos).
pytest -m integration
```

Fixtures versionadas em `src/document_intelligence/tests/fixtures/` são PDFs
sintéticos (sem PII), gerados por `generate_fixtures.py`. Os testes de integração
cobrem: PDF de texto multipágina, ordem/numeração/bbox, tabela, **imagem real**,
contrato e o endpoint HTTP completo. Testes rápidos cobrem: PDF inválido, vazio,
path traversal, corrompido, limite de páginas (inclusive sem chamar o parser),
timeout, admissão/429, cancelamento, liberação de slot e parsing de HTML.
