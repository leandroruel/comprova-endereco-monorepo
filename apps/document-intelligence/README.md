# Document Intelligence

Serviço independente de processamento documental em **Python + Tesseract 5 + FastAPI**.
Recebe um PDF, executa OCR convencional (sem VLM, sem LLM) e devolve um **JSON
estruturado e versionado** para a API do Comprova consumir por HTTP.

- **Não guarda documentos** (arquivo temporário é apagado sempre, inclusive em erro).
- **Não usa LLM nem VLM** para extração: apenas OCR convencional com Tesseract 5.
- **Não contém regras fiscais, autenticação ou regra de negócio** — isso continua
  na API/domínio do Comprova.
- **Não depende de serviços externos pagos** — todo o processamento é local.

## Arquitetura

```text
Comprova API (Fastify/TS)
        │  multipart/form-data (PDF)
        ▼
Document Intelligence (FastAPI/Python)
        │
        ▼
Tesseract 5  ── OCR convencional (idioma: português)
        │
        ▼
JSON estruturado (contrato v1.0) ──► API do Comprova
```

O serviço é independente do ciclo de vida da API. A API conversa com ele por
HTTP usando `DOCUMENT_INTELLIGENCE_URL`.

### Fluxo interno de uma requisição

0. **Admissão** (middleware): capacidade `DI_MAX_CONCURRENCY + DI_MAX_QUEUE`;
   excedente → `429` **antes de ler o upload**. O slot só é liberado quando a
   thread de processamento termina (inclusive em timeout/cancelamento).
1. Validação de segurança (assinatura `%PDF-`, magic bytes, tamanho, nome do arquivo).
2. Inspeção barata com `pypdfium2` (contagem de páginas, PDF criptografado,
   limite `DI_MAX_PAGES`) — **antes** de qualquer processamento.
3. Para cada página:
   - Extrai a camada textual se disponível e utilizável (PDF digital);
   - Caso contrário, renderiza a página como imagem e executa OCR com Tesseract
     (PDF escaneado).
4. Normaliza os resultados (páginas, elementos, bounding boxes, confiança)
   e monta o contrato HTTP. Remove o temporário.

## Requisitos

- Python `>=3.10,<4` (recomendado 3.11)
- Dependências de sistema: `tesseract-ocr`, `tesseract-ocr-por`,
  `libgl1`, `libglib2.0-0`, `libgomp1`, fontes (`fonts-liberation`).
  O `Dockerfile` já instala tudo.

## Instalação e execução local

Com [uv](https://docs.astral.sh/uv/):

```bash
cd apps/document-intelligence
uv venv .venv
source .venv/bin/activate
uv pip install -e .
uv sync --extra dev   # dependências de teste (pytest etc.)
DI_PRELOAD_MODELS=true DI_WARMUP=true python -m document_intelligence
```

Sem `uv`, use `python -m venv .venv` + `pip install -e ".[dev]"`.

### Docker

```bash
# Contexto = este diretório.
docker build -t document-intelligence apps/document-intelligence
docker run --rm -p 8000:8000 \
  -v di-tmp:/tmp/document-intelligence \
  document-intelligence
```

Ou via `docker compose` na raiz — o serviço é **opt-in** (perfil dedicado) para
não pesar o stack padrão:

```bash
docker compose --profile document-intelligence up -d document-intelligence
```

O Dockerfile instala o Tesseract 5 com dados de idioma português (`por`).
Não há downloads de modelos de VLM nem binários do llama.cpp.

## Configuração

Todas as variáveis usam o prefixo `DI_`.

| Variável                   | Default   | Descrição                                                   |
| -------------------------- | --------- | ----------------------------------------------------------- |
| `DI_HOST`                  | `0.0.0.0` | Host de escuta                                              |
| `DI_PORT`                  | `8000`    | Porta                                                       |
| `DI_LOG_LEVEL`             | `info`    | `debug`/`info`/`warning`/`error`                            |
| `DI_LOG_FILE`              | —         | Arquivo de log opcional (além do stdout JSON)               |
| `DI_MAX_FILE_SIZE_MB`      | `30`      | Tamanho máximo do upload                                    |
| `DI_MAX_CONCURRENCY`       | `1`       | Slots de processamento (OCR é serializado por processo)     |
| `DI_MAX_QUEUE`             | `2`       | Requisições admitidas aguardando o worker; excedente → 429  |
| `DI_TIMEOUT_S`             | `300`     | Timeout por documento                                       |
| `DI_MAX_PAGES`             | `100`     | Limite de páginas aplicado antes da inferência; acima → 422 |
| `DI_INCLUDE_IMAGES`        | `false`   | Embute recortes de imagem como data URL (reservado)         |
| `DI_MAX_IMAGE_BYTES`       | `262144`  | Teto por imagem embutida (256 KiB)                          |
| `DI_MAX_TOTAL_IMAGE_BYTES` | `2097152` | Teto total de imagens por documento (2 MiB)                 |
| `DI_PRELOAD_MODELS`        | `true`    | Verifica dependências no startup                            |
| `DI_WARMUP`                | `true`    | Roda um PDF sintético no startup para verificar o pipeline  |
| `DI_OCR_LANG`              | `por`     | Idioma do Tesseract                                         |
| `DI_OCR_DPI`               | `200`     | DPI de renderização de páginas PDF para OCR                 |
| `DI_OCR_PREPROCESS`        | `false`   | Aplica pré-processamento com OpenCV antes do OCR            |
| `DI_TEMP_DIR`              | —         | Diretório dos temporários (default: sistema)                |
| `DI_MIN_FREE_MEMORY_MB`    | `512`     | Mínimo de memória livre para `/ready`                       |

A capacidade de admissão é `DI_MAX_CONCURRENCY + DI_MAX_QUEUE`. Acima disso o
serviço responde `429` **antes de ler o corpo do upload** — não existe fila
ilimitada nem acúmulo de PDFs inteiros em memória.

## Endpoints

### `GET /health`

**Liveness.** Responde `200` imediatamente enquanto o processo está vivo. **Não**
carrega modelos nem depende de warmup — pode responder `200` durante o
carregamento.

```json
{ "status": "ok", "service": "document-intelligence", "version": "0.1.0", "marker_available": true }
```

### `GET /ready`

**Readiness.** Retorna `200` **somente** quando o Tesseract está instalado com
o idioma `por`, o warmup concluiu (se habilitado) e memória livre ≥
`DI_MIN_FREE_MEMORY_MB`. Caso contrário retorna **`503`** com
`status: "not_ready"` no corpo.

Orquestradores devem usar `/ready` para decidir roteamento e `/health` apenas
para reiniciar o processo. O `docker-compose.yml` usa `/ready` no healthcheck
(readiness); o `Dockerfile` mantém `HEALTHCHECK` de liveness em `/health`.

### `POST /documents/parse`

`multipart/form-data` com o campo `file` (PDF) e, opcionalmente, `document_id`.

Respostas:

- `200` — contrato completo (`status: "completed"` ou `"failed"` se o processamento falhar).
- `400` — não é PDF, arquivo vazio, nome com path traversal ou PDF corrompido.
- `413` — upload acima de `DI_MAX_FILE_SIZE_MB` (aborta a leitura no limite).
- `422` — PDF criptografado ou acima de `DI_MAX_PAGES` (inspeção prévia,
  sem processamento).
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

`contractVersion` fica em `metadata.contractVersion`.

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
          "id": "p1-layer-1",
          "type": "text",
          "text": "CONTRATO DE PRESTACAO DE SERVICOS ...",
          "bbox": null,
          "confidence": null,
          "table": null,
          "imageRef": null,
          "metadata": { "source": "text_layer" }
        }
      ]
    }
  ],
  "metadata": {
    "processor": "tesseract",
    "processorVersion": "5.5.0",
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

O Tesseract não detecta tabelas estruturadas. Elementos de tipo `table` não são
produzidos pelo pipeline atual (sempre `null`).

### Imagens (`type: "image"`)

O pipeline atual não embute recortes de imagem como data URL (`DI_INCLUDE_IMAGES`
padrão é `false`). Elementos de tipo `image` não são produzidos.

### `confidence`

O Tesseract expõe confiança por linha de texto reconhecida. O campo é preenchido
quando o texto vem de OCR (`source: "ocr"`) e `null` quando vem da camada
textual do PDF (`source: "text_layer"`).

## Observabilidade

Logs estruturados em JSON (stdout) com `document_id`, duração, páginas, status,
tipo de erro e versão do Tesseract. **Nunca** são logados texto extraído, CPF/CNPJ,
endereço ou qualquer conteúdo do documento.

## Desempenho, memória e limitações

O Tesseract é consideravelmente mais leve que o Marker + Surya + PyTorch:

| Cenário                                   | Tempo (estimado) |
| ----------------------------------------- | ---------------- |
| PDF com camada de texto (2 páginas)       | ~100 ms          |
| PDF escaneado com OCR (1 página, 200 DPI) | ~1–3 s           |
| RAM recomendada no host                   | 512 MiB – 1 GiB  |

- **Não há detecção de layout**: o Tesseract reconhece texto, não estrutura
  (títulos, tabelas, figuras). Todo o texto vira elementos do tipo `text`.
- **Não há extração de tabelas**: tabelas não são detectadas como estruturas
  estruturadas (`table` é sempre `null`).
- **Não há recortes de imagem**: `imageRef` é sempre `null`.
- O processamento é serializado por processo (Tesseract/pypdfium2 não são
  thread-safe). Para paralelismo, use múltiplas réplicas do serviço.
- **Admissão**: a capacidade total é `DI_MAX_CONCURRENCY + DI_MAX_QUEUE`
  (default `1 + 2`). O excedente recebe `429` com `Retry-After` **antes** de o
  corpo ser lido; não há fila ilimitada. Em timeout (`504`) o slot permanece
  ocupado até a thread terminar, e o mesmo vale para cancelamento do cliente.
- **Limite de páginas**: `DI_MAX_PAGES` (default `100`) é verificado com
  `pypdfium2` **antes** de qualquer processamento; PDFs acima do limite
  retornam `422` sem OCR.
- Para produção com volume, prefira múltiplas réplicas atrás de um load
  balancer.
- O serviço não deve ser exposto publicamente sem autenticação/rede interna.

## Testes

```bash
cd apps/document-intelligence
source .venv/bin/activate   # ou: uv sync --extra dev (ver Instalação)

# Rápidos (não exigem Tesseract): segurança, contrato, fila, API.
pytest -m "not integration"

# Integração com o Tesseract real (exige tesseract + idioma 'por' instalados).
pytest -m integration
```

## Dependências removidas (versão anterior)

- `marker-pdf==2.1.0` — removido (substituído pelo Tesseract)
- `torch` / `torchvision` — removido (não é mais necessário)
- `llama.cpp` / `llama-server` — removido (não é mais necessário)
- Downloads de pesos de modelo (Surya, layout, reconhecimento) — removidos

## Dependências adicionadas

- `pypdfium2>=4,<6` — renderização de PDF e extração de camada textual
- `Pillow>=10,<12` — manipulação de imagens para OCR
- `opencv-python-headless>=4.8,<5` — pré-processamento opcional de imagens
- `pytesseract>=0.3,<1` — wrapper Python para o Tesseract
- `tesseract-ocr` + `tesseract-ocr-por` (sistema) — mecanismo de OCR
