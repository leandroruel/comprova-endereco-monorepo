"""Logging estruturado para o serviço Document Intelligence.

Segue o mesmo padrão do restante do monorepo (pino-style JSON estruturado):
campos como ``documentId``, duração de processamento e quantidade de páginas
são registrados, mas nunca o conteúdo extraído, CPF, CNPJ, endereço ou outros
dados pessoais.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog


def configure_logging(level: str = "info", log_file: str | None = None) -> None:
    """Configura o structlog com saída JSON (stdout e opcionalmente arquivo)."""

    processors: list[Any] = [
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.dict_tracebacks,
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ]

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file is not None:
        handlers.append(logging.FileHandler(log_file))

    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        handlers=handlers,
        force=True,
    )

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "document-intelligence") -> structlog.stdlib.BoundLogger:
    """Retorna um logger structlog ligado ao logging padrão do Python."""
    return structlog.get_logger(name)
