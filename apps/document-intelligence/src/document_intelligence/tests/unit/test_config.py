"""Testes de configuração: limites padrão e override por ambiente."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from document_intelligence.config import Settings


def test_limite_de_paginas_tem_default_seguro(monkeypatch: pytest.MonkeyPatch) -> None:
    """A instalação padrão nunca fica sem limite de páginas."""
    monkeypatch.delenv("DI_MAX_PAGES", raising=False)
    settings = Settings()

    assert isinstance(settings.max_pages, int)
    assert settings.max_pages == 100
    assert settings.max_pages >= 1


def test_limite_de_paginas_nao_aceita_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """``None``/``0`` são rejeitados: não existe modo "sem limite"."""
    monkeypatch.delenv("DI_MAX_PAGES", raising=False)
    with pytest.raises(ValidationError):
        Settings(max_pages=None)  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        Settings(max_pages=0)


def test_limite_de_paginas_configuravel_por_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """``DI_MAX_PAGES`` altera o limite aplicado antes da inferência."""
    monkeypatch.setenv("DI_MAX_PAGES", "7")
    assert Settings().max_pages == 7


def test_defaults_de_admissao_e_imagens(monkeypatch: pytest.MonkeyPatch) -> None:
    """Defaults explícitos de fila e de imagens."""
    for name in (
        "DI_MAX_QUEUE",
        "DI_INCLUDE_IMAGES",
        "DI_MAX_IMAGE_BYTES",
        "DI_MAX_TOTAL_IMAGE_BYTES",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = Settings()

    assert settings.max_concurrency == 1
    assert settings.max_queue == 2
    assert settings.include_images is True
    assert settings.max_image_bytes < settings.max_total_image_bytes
