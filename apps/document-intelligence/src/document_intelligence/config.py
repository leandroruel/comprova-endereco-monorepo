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
    # A inferência local do Marker é serializada (não é thread-safe). Este valor
    # limita quantas requisições ficam em processamento/fila por processo.
    max_concurrency: int = Field(default=1, ge=1, le=64)
    timeout_s: int = Field(default=300, ge=1, le=3600)
    max_pages: int | None = Field(default=None, ge=1)

    # Modelos / processamento
    # Carrega os modelos do Marker no startup (recomendado). Se ``False``, o
    # carregamento acontece na primeira requisição de parsing.
    preload_models: bool = Field(default=True)
    # Executa um documento sintético no startup para carregar os modelos de
    # layout/OCR (o primeiro documento com tabela pode levar minutos em CPU).
    warmup: bool = Field(default=True)
    # Diretório de trabalho para arquivos temporários. ``None`` usa o diretório
    # temporário do sistema (respeitando ``TMPDIR``).
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
