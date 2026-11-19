"""Testes de health/readiness: nao executam subprocessos bloqueantes."""

from __future__ import annotations

from fastapi.testclient import TestClient

import document_intelligence.main as main


def test_health_nao_chama_subprocesso_bloqueante(monkeypatch) -> None:
    """O endpoint /health nao deve chamar is_tesseract_available (subprocesso).

    A disponibilidade e a verificada no startup e armazenada.
    """
    calls = []

    def fake_available(lang="por"):
        calls.append(lang)
        return True

    monkeypatch.setattr(main, "is_tesseract_available", fake_available)
    monkeypatch.setattr(main, "tesseract_available_at_startup", True)

    client = TestClient(main.app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["tesseract_available"] is True
    # Nenhuma chamada a is_tesseract_available durante o endpoint /health.
    assert calls == []


def test_health_tesseract_indisponivel(monkeypatch) -> None:
    """Health ainda responde 200 (liveness) mesmo sem Tesseract."""
    monkeypatch.setattr(main, "tesseract_available_at_startup", False)

    client = TestClient(main.app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["tesseract_available"] is False


def test_ready_com_tesseract_disponivel(monkeypatch) -> None:
    """Ready retorna 200 quando Tesseract disponível no startup."""
    monkeypatch.setattr(main, "tesseract_available_at_startup", True)
    monkeypatch.setattr(main, "parser_ready", True)
    monkeypatch.setattr(main, "parser_warmed", True)

    client = TestClient(main.app)
    response = client.get("/ready")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert data["models_loaded"] is True
    assert "tesseract" in data["checks"]


def test_ready_sem_tesseract_retorna_503(monkeypatch) -> None:
    """Ready retorna 503 quando Tesseract nao disponível no startup."""
    monkeypatch.setattr(main, "tesseract_available_at_startup", False)
    monkeypatch.setattr(main, "parser_ready", False)
    monkeypatch.setattr(main, "parser_warmed", True)

    client = TestClient(main.app)
    response = client.get("/ready")

    assert response.status_code == 503
    data = response.json()
    assert data["status"] == "not_ready"
    assert data["models_loaded"] is False


def test_ready_verifica_idioma_configurado(monkeypatch) -> None:
    """Ready reporta o idioma configurado na verificacao do Tesseract."""
    monkeypatch.setattr(main.settings, "ocr_lang", "por")
    monkeypatch.setattr(main, "tesseract_available_at_startup", True)
    monkeypatch.setattr(main, "parser_ready", True)
    monkeypatch.setattr(main, "parser_warmed", True)

    client = TestClient(main.app)
    response = client.get("/ready")

    assert response.status_code == 200
    data = response.json()
    assert "por" in data["checks"]["tesseract"]
