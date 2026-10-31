"""Ponto de entrada: ``python -m document_intelligence``.

Os modelos são carregados pelo ``lifespan`` da aplicação (controlado por
``DI_PRELOAD_MODELS``); não carregamos aqui para evitar duplicação.
"""

from __future__ import annotations

from .config import settings
from .logging import configure_logging, get_logger


def main() -> None:
    configure_logging(level=settings.log_level, log_file=settings.log_file)
    logger = get_logger("document-intelligence.cli")
    logger.info("inicializando_servico_document_intelligence")

    import uvicorn

    uvicorn.run(
        "document_intelligence.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    main()
