# syntax=docker/dockerfile:1
# Build a partir deste diretório:
#   docker build -t document-intelligence apps/document-intelligence
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependências de sistema do Marker/Surya (renderização de PDF, OpenCV, fontes).
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        fontconfig \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# PyTorch/Torchvision CPU (imagem menor; use a variante CUDA para GPU).
RUN pip install --no-cache-dir torch torchvision \
        --index-url https://download.pytorch.org/whl/cpu

# Código + dependências Python (marker-pdf, fastapi, etc.).
COPY pyproject.toml ./pyproject.toml
COPY src ./src
RUN pip install --no-cache-dir .

# Cache persistível de pesos (montar como volume em produção).
ENV MODEL_CACHE_DIR=/app/.cache/models \
    HF_HOME=/app/.cache/huggingface \
    DI_TEMP_DIR=/tmp/document-intelligence
RUN mkdir -p "$MODEL_CACHE_DIR" "$HF_HOME" "$DI_TEMP_DIR" \
    && chmod -R 777 /app/.cache "$DI_TEMP_DIR"

# Executa como usuário não-root.
USER nobody

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else sys.exit(1)"

CMD ["python", "-m", "document_intelligence"]
