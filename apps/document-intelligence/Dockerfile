# syntax=docker/dockerfile:1
# Build a partir deste diretório:
#   docker build -t document-intelligence apps/document-intelligence
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependências de sistema: Tesseract (OCR), dados de idioma português,
# renderização de PDF (pypdfium2 precisa de libs do pdfium), OpenCV e fontes.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-por \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        fontconfig \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Código + dependências Python (fastapi, pypdfium2, pytesseract, etc.).
COPY pyproject.toml ./pyproject.toml
COPY src ./src
RUN pip install --no-cache-dir .

# Diretório de trabalho para arquivos temporários.
ENV DI_TEMP_DIR=/tmp/document-intelligence \
    DI_OCR_LANG=por \
    DI_OCR_DPI=200 \
    DI_OCR_PREPROCESS=false

RUN mkdir -p "$DI_TEMP_DIR" && chmod -R 777 "$DI_TEMP_DIR"

# Executa como usuário não-root.
USER nobody

EXPOSE 8000

# Liveness: o processo está vivo (não exige Tesseract carregado). Readiness
# (/ready, 503 até Tesseract disponível + warmup) é usada pelo orquestrador.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else sys.exit(1)"

CMD ["python", "-m", "document_intelligence"]
