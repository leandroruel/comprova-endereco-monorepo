"""Testes de API rápidos (não carregam modelos)."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "document-intelligence"


def test_ready_formato(client: TestClient) -> None:
    response = client.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ready", "not_ready"}
    assert "marker_modelos" in body["checks"]


def test_rejeita_nao_pdf(client: TestClient) -> None:
    response = client.post(
        "/documents/parse",
        files={"file": ("nota.txt", b"isto nao eh um pdf", "application/pdf")},
    )
    assert response.status_code == 400


def test_rejeita_arquivo_vazio(client: TestClient) -> None:
    response = client.post(
        "/documents/parse",
        files={"file": ("vazio.pdf", b"", "application/pdf")},
    )
    assert response.status_code == 400


def test_rejeita_path_traversal(client: TestClient) -> None:
    response = client.post(
        "/documents/parse",
        files={
            "file": (
                "../etc/passwd.pdf",
                b"%PDF-1.7\nconteudo",
                "application/pdf",
            )
        },
    )
    assert response.status_code == 400


def test_rejeita_pdf_corrompido(client: TestClient) -> None:
    # Assinatura válida, mas estrutura interna inválida.
    response = client.post(
        "/documents/parse",
        files={
            "file": (
                "corrompido.pdf",
                b"%PDF-1.7\nlixo sem xref nem trailer",
                "application/pdf",
            )
        },
    )
    assert response.status_code == 400


def test_timeout_responde_504(client: TestClient, sample_text_pdf, monkeypatch) -> None:
    import time

    from document_intelligence import main

    monkeypatch.setattr(main.settings, "timeout_s", 1)
    monkeypatch.setattr(main.parser, "parse", lambda *args, **kwargs: time.sleep(2))

    conteudo = sample_text_pdf.read_bytes()
    response = client.post(
        "/documents/parse",
        files={"file": ("sample_text.pdf", conteudo, "application/pdf")},
    )

    assert response.status_code == 504
    assert "timeout" in response.json()["detail"].lower()
