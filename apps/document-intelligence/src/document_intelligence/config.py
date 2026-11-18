"""Configuração do serviço Document Intelligence.

Todas as variáveis são lidas de variáveis de ambiente com o prefixo ``DI_``
(via :class:`pydantic_settings.BaseSettings`). Valores ausentes usam os
padrões descritos no README.
"""

from __future__ import annotations

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DI_", env_file=".env", extra="ignore"
    )

    # Servidor
    port: int = Field(default=8000, ge=1, le=65535)
    host: str = Field(default="0.0.0.0")
    log_level: str = Field(default="info")
    log_file: str | None = Field(default=None)

    # Limites
    max_file_size_mb: int = Field(default=30, ge=1, le=1024)
    # O processamento local com Tesseract é serializado por processo. Este
    # valor limita quantas requisições ficam em processamento/fila.
    max_concurrency: int = Field(default=1, ge=1, le=64)
    # Requisições adicionais admitidas aguardando o worker.
    max_queue: int = Field(default=2, ge=0, le=1024)
    timeout_s: int = Field(default=300, ge=1, le=3600)
    # Limite de páginas explícito com default seguro.
    max_pages: int = Field(default=100, ge=1)

    # Imagens detectadas (reservado para futuro uso; atualmente os recortes
    # de imagem não são gerados pelo Tesseract).
    include_images: bool = Field(default=False)
    max_image_bytes: int = Field(default=262_144, ge=1)
    max_total_image_bytes: int = Field(default=2_097_152, ge=1)

    # OCR / processamento
    # Carrega/verifica dependências no startup (recomendado).
    preload_models: bool = Field(default=True)
    # Executa um documento sintético no startup para verificar o pipeline.
    warmup: bool = Field(default=True)
    # Idioma do Tesseract (padrão: português).
    ocr_lang: str = Field(default="por")
    # DPI de renderização de páginas PDF para OCR.
    ocr_dpi: int = Field(default=200, ge=72, le=600)
    # Aplica pré-processamento com OpenCV antes do OCR.
    ocr_preprocess: bool = Field(default=False)
    # Diretório de trabalho para arquivos temporários.
    temp_dir: str | None = Field(default=None)
    # Mínimo de memória livre (MiB) exigido em ``/ready``.
    min_free_memory_mb: int = Field(default=512, ge=0)

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        """Normaliza ``warn`` para ``warning`` (nível aceito por uvicorn)."""
        normalized = value.lower()
        if normalized == "warn":
            normalized = "warning"
        if normalized not in {"debug", "info", "warning", "error", "critical"}:
            raise ValueError(f"log_level inválido: {value}")
        return normalized


settings = Settings()
