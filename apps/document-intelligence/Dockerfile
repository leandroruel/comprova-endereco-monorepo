# syntax=docker/dockerfile:1
# Build a partir deste diretório:
#   docker build -t document-intelligence apps/document-intelligence
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependências de sistema do Marker/Surya (renderização de PDF, OpenCV, fontes)
# e curl para baixar o binário do llama.cpp (backend OCR de CPU).
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        fontconfig \
        fonts-liberation \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Backend OCR de CPU exigido pelo Marker 2.1.0/Surya: na ausência de GPU o
# modelo VLM (surya-ocr-2.5) roda via `llama-server` (llama.cpp). Sem este
# binário, PDFs escaneados falham com SpawnError. Alternativa em produção:
# aponte SURYA_INFERENCE_URL para um servidor de inferência dedicado e remova
# este bloco.
ARG LLAMA_CPP_RELEASE=b12018
RUN mkdir -p /opt/llama-cpp \
    && curl -fsSL \
        "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE}/llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-x64.tar.gz" \
        | tar -xz -C /opt/llama-cpp --strip-components=1 \
    && chmod -R a+rX /opt/llama-cpp
ENV LLAMA_CPP_BINARY=/opt/llama-cpp/llama-server \
    LD_LIBRARY_PATH=/opt/llama-cpp

# PyTorch/Torchvision CPU (imagem menor; use a variante CUDA para GPU).
RUN pip install --no-cache-dir torch torchvision \
        --index-url https://download.pytorch.org/whl/cpu

# Código + dependências Python (marker-pdf, fastapi, etc.).
COPY pyproject.toml ./pyproject.toml
COPY src ./src
RUN pip install --no-cache-dir .

# Cache persistível de pesos (montar como volume em produção).
# FONT_DIR/FONT_PATH/DEBUG_DATA_FOLDER: Marker resolve FONT_PATH na definição
# da classe com o default de FONT_DIR (ignora o override por env) e ambos
# apontam para o site-packages (read-only no runtime não-root). Sem isso,
# load_models falha com PermissionError como nobody.
ENV MODEL_CACHE_DIR=/app/.cache/models \
    HF_HOME=/app/.cache/huggingface \
    DI_TEMP_DIR=/tmp/document-intelligence \
    FONT_DIR=/app/.cache/fonts \
    FONT_PATH=/app/.cache/fonts/GoNotoCurrent-Regular.ttf \
    DEBUG_DATA_FOLDER=/tmp/document-intelligence/debug
RUN mkdir -p "$MODEL_CACHE_DIR" "$HF_HOME" "$FONT_DIR" "$DEBUG_DATA_FOLDER" "$DI_TEMP_DIR" \
    && chmod -R 777 /app/.cache "$DI_TEMP_DIR"

# HOME gravável para o usuário não-root: o Surya grava locks/logs dos
# servidores de inferência em ~/.cache/datalab/surya, e o `nobody` tem
# HOME=/nonexistent por padrão (falha ao criar o diretório).
ENV HOME=/app/.cache

# Executa como usuário não-root.
USER nobody

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else sys.exit(1)"

CMD ["python", "-m", "document_intelligence"]
