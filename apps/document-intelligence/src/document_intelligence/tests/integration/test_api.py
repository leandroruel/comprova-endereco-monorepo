"""Testes de API rápidos (não carregam modelos)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from document_intelligence import main
from document_intelligence.schemas import (
    DocumentInfo,
    ParseResponse,
    ProcessingMetadata,
)


def _fake_response(document_id: str) -> ParseResponse:
    """Resposta mínima compatível com o contrato (sem Marker)."""
    return ParseResponse(
        document_id=document_id,
        status="completed",
        document=DocumentInfo(
            mime_type="application/pdf", page_count=2, size_bytes=10
        ),
        content={"text": "ok", "markdown": "ok"},
        metadata=ProcessingMetadata(
            processor_version="2.1.0", processing_time_ms=1
        ),
    )


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "document-intelligence"


def test_health_200_durante_carregamento_de_modelos(
    client: TestClient, monkeypatch
) -> None:
    """Liveness não depende de modelos carregados nem de warmup."""
    monkeypatch.setattr(main.parser, "_loaded", False)
    monkeypatch.setattr(main.parser, "_warm", False)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ready_reflete_prontidao(client: TestClient) -> None:
    """200 só quando pronto; 503 quando ``not_ready``."""
    response = client.get("/ready")
    body = response.json()

    assert body["status"] in {"ready", "not_ready"}
    assert response.status_code == (200 if body["status"] == "ready" else 503)
    assert "marker_modelos" in body["checks"]
    assert body["checks"]["max_paginas"] == str(main.settings.max_pages)


def test_ready_503_antes_de_carregar_modelos(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setattr(main.parser, "_loaded", False)

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert response.json()["models_loaded"] is False


def test_ready_503_durante_warmup(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(main.parser, "_loaded", True)
    monkeypatch.setattr(main.parser, "_warm", False)
    monkeypatch.setattr(main.settings, "warmup", True)

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"


def test_ready_503_com_memoria_insuficiente(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setattr(main.parser, "_loaded", True)
    monkeypatch.setattr(main.settings, "warmup", False)
    monkeypatch.setattr(main.settings, "min_free_memory_mb", 10**9)

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert "memoria_livre_mb" in response.json()["checks"]


def test_ready_200_quando_tudo_esta_pronto(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(main.parser, "_loaded", True)
    monkeypatch.setattr(main.parser, "_warm", True)
    monkeypatch.setattr(main.settings, "warmup", False)
    monkeypatch.setattr(main.settings, "min_free_memory_mb", 0)

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_pdf_dentro_do_limite_de_paginas_e_aceito(
    client: TestClient, sample_text_pdf, monkeypatch
) -> None:
    """PDF de 2 páginas com limite 3 → segue para a inferência."""
    monkeypatch.setattr(main.settings, "max_pages", 3)
    monkeypatch.setattr(
        main.parser, "parse", lambda path, document_id, size_bytes=0: _fake_response(document_id)
    )

    response = client.post(
        "/documents/parse",
        files={"file": ("ok.pdf", sample_text_pdf.read_bytes(), "application/pdf")},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"


def test_pdf_exatamente_no_limite_de_paginas_e_aceito(
    client: TestClient, sample_text_pdf, monkeypatch
) -> None:
    """PDF de 2 páginas com limite 2 → aceito (limite é inclusivo)."""
    monkeypatch.setattr(main.settings, "max_pages", 2)
    monkeypatch.setattr(
        main.parser, "parse", lambda path, document_id, size_bytes=0: _fake_response(document_id)
    )

    response = client.post(
        "/documents/parse",
        files={"file": ("ok.pdf", sample_text_pdf.read_bytes(), "application/pdf")},
    )

    assert response.status_code == 200


def test_pdf_acima_do_limite_responde_422_sem_chamar_o_parser(
    client: TestClient, sample_text_pdf, monkeypatch
) -> None:
    """O limite é aplicado na inspeção prévia: o Marker nem é chamado."""
    monkeypatch.setattr(main.settings, "max_pages", 1)
    chamadas: list[str] = []

    def fake_parse(path, document_id, size_bytes=0):
        chamadas.append(document_id)
        return _fake_response(document_id)

    monkeypatch.setattr(main.parser, "parse", fake_parse)

    response = client.post(
        "/documents/parse",
        files={"file": ("grande.pdf", sample_text_pdf.read_bytes(), "application/pdf")},
    )

    assert response.status_code == 422
    assert "páginas" in response.json()["detail"]
    assert chamadas == [], "parser.parse foi chamado antes de aplicar o limite"


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


def test_rejeita_arquivo_acima_do_limite_com_413(client: TestClient, monkeypatch) -> None:
    """A leitura em blocos para cedo: payload maior que o limite vira 413
    sem ser totalmente recebido/bufferizado."""
    import io

    from document_intelligence import main

    monkeypatch.setattr(main.settings, "max_file_size_mb", 1)
    payload = b"%PDF-1.7\n" + b"a" * (2 * 1024 * 1024)
    response = client.post(
        "/documents/parse",
        files={"file": ("grande.pdf", io.BytesIO(payload), "application/pdf")},
    )
    assert response.status_code == 413
    assert "limite" in response.json()["detail"].lower()


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
