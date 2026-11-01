"""Configuração de pytest do serviço Document Intelligence."""

from __future__ import annotations

import os
from pathlib import Path

# Desativa o pré-carregamento/aquecimento no ciclo de vida do app durante os
# testes, para que o TestClient não baixe/carregue modelos. Os testes de
# integração que realmente precisam do Marker o fazem explicitamente.
os.environ.setdefault("DI_PRELOAD_MODELS", "false")
os.environ.setdefault("DI_WARMUP", "false")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "integration: teste de integracao (exige modelos do Marker)"
    )


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def marker_available() -> bool:
    """True se o pacote Marker pode ser importado neste ambiente."""
    try:
        import marker  # noqa: F401

        return True
    except Exception:
        return False


requires_marker = pytest.mark.skipif(
    not marker_available(), reason="Marker não instalado neste ambiente"
)


@pytest.fixture
def client() -> TestClient:
    from document_intelligence.main import app

    return TestClient(app)


@pytest.fixture
def sample_text_pdf() -> Path:
    return FIXTURES_DIR / "sample_text.pdf"


@pytest.fixture
def sample_table_pdf() -> Path:
    return FIXTURES_DIR / "sample_table.pdf"
