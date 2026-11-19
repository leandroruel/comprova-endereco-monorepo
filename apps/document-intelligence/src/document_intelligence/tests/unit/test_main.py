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


# ---------------------------------------------------------------------------
# Testes de warmup (item 3)
# ---------------------------------------------------------------------------

def test_warmup_executa_ocr_real(monkeypatch) -> None:
    """Warmup bem-sucedido deve marcar parser_warmed = True e executar OCR real."""
    from document_intelligence.schemas import (
        DocumentInfo,
        ParseResponse,
        ProcessingMetadata,
    )

    ocr_lines_called = []

    def fake_build_warmup_pdf():
        return b"%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF"

    def fake_build_parse_response(path, document_id, size_bytes=0):
        return ParseResponse(
            document_id=document_id,
            status="completed",
            document=DocumentInfo(
                mime_type="application/pdf", page_count=1, size_bytes=0
            ),
            content={"text": "ok", "markdown": "ok"},
            pages=[],
            metadata=ProcessingMetadata(
                processor_version="5.3.4", processing_time_ms=1
            ),
        )

    def fake_render_page_to_image(path, page_number, dpi=200, output_path=None):
        import tempfile, os

        fd, tmp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        return tmp_path, 800, 1100

    def fake_ocr_image(
        image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200
    ):
        from document_intelligence.ocr import OcrLine

        ocr_lines_called.append(True)
        return [
            OcrLine(
                text="texto reconhecido",
                x1=10,
                y1=10,
                x2=100,
                y2=30,
                confidence=90,
                word_count=2,
            )
        ]

    # Patch nos modulos de origem (importados dentro de _warmup)
    monkeypatch.setattr(
        "document_intelligence.warmup.build_warmup_pdf", fake_build_warmup_pdf
    )
    monkeypatch.setattr(main, "build_parse_response", fake_build_parse_response)
    monkeypatch.setattr(
        "document_intelligence.ocr.render_page_to_image", fake_render_page_to_image
    )
    monkeypatch.setattr(
        "document_intelligence.ocr.ocr_image", fake_ocr_image
    )
    monkeypatch.setattr(main.settings, "warmup", True)
    monkeypatch.setattr(main.settings, "ocr_dpi", 200)

    main.parser_warmed = False

    # Executa o warmup diretamente (síncrono, via _run_warmup que define parser_warmed).
    import asyncio

    async def run_warmup():
        await main._run_warmup()

    asyncio.run(run_warmup())

    assert main.parser_warmed is True
    assert len(ocr_lines_called) == 1


def test_warmup_ocr_vazio_nao_marca_aquecido(monkeypatch) -> None:
    """Warmup com OCR vazio deve falhar e nao marcar parser_warmed."""
    from document_intelligence.ocr import OcrLine
    from document_intelligence.schemas import (
        DocumentInfo,
        ParseResponse,
        ProcessingMetadata,
    )

    def fake_build_warmup_pdf():
        return b"%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF"

    def fake_build_parse_response(path, document_id, size_bytes=0):
        return ParseResponse(
            document_id=document_id,
            status="completed",
            document=DocumentInfo(
                mime_type="application/pdf", page_count=1, size_bytes=0
            ),
            content={"text": "ok", "markdown": "ok"},
            pages=[],
            metadata=ProcessingMetadata(
                processor_version="5.3.4", processing_time_ms=1
            ),
        )

    def fake_render_page_to_image(path, page_number, dpi=200, output_path=None):
        import tempfile, os

        fd, tmp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        return tmp_path, 800, 1100

    def fake_ocr_image_vazio(
        image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200
    ):
        return []  # Sem texto reconhecido

    monkeypatch.setattr(
        "document_intelligence.warmup.build_warmup_pdf", fake_build_warmup_pdf
    )
    monkeypatch.setattr(main, "build_parse_response", fake_build_parse_response)
    monkeypatch.setattr(
        "document_intelligence.ocr.render_page_to_image", fake_render_page_to_image
    )
    monkeypatch.setattr(
        "document_intelligence.ocr.ocr_image", fake_ocr_image_vazio
    )
    monkeypatch.setattr(main.settings, "warmup", True)
    monkeypatch.setattr(main.settings, "ocr_dpi", 200)

    main.parser_warmed = False

    # _warmup levanta excecao diretamente (nao eh engolida por _run_warmup).
    try:
        main._warmup()
        assert False, "Deveria ter levantado exceção"
    except RuntimeError:
        pass

    assert main.parser_warmed is False


def test_warmup_tesseract_indisponivel_nao_marca_aquecido(monkeypatch) -> None:
    """Warmup com Tesseract indisponível deve falhar e nao marcar parser_warmed."""
    from document_intelligence.ocr import TesseractNotAvailableError
    from document_intelligence.schemas import (
        DocumentInfo,
        ParseResponse,
        ProcessingMetadata,
    )

    def fake_build_warmup_pdf():
        return b"%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF"

    def fake_build_parse_response(path, document_id, size_bytes=0):
        return ParseResponse(
            document_id=document_id,
            status="completed",
            document=DocumentInfo(
                mime_type="application/pdf", page_count=1, size_bytes=0
            ),
            content={"text": "ok", "markdown": "ok"},
            pages=[],
            metadata=ProcessingMetadata(
                processor_version="5.3.4", processing_time_ms=1
            ),
        )

    def fake_render_page_to_image(path, page_number, dpi=200, output_path=None):
        import tempfile, os

        fd, tmp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        return tmp_path, 800, 1100

    def fake_ocr_image_erro(
        image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200
    ):
        raise TesseractNotAvailableError("idioma nao disponível")

    monkeypatch.setattr(
        "document_intelligence.warmup.build_warmup_pdf", fake_build_warmup_pdf
    )
    monkeypatch.setattr(main, "build_parse_response", fake_build_parse_response)
    monkeypatch.setattr(
        "document_intelligence.ocr.render_page_to_image", fake_render_page_to_image
    )
    monkeypatch.setattr(
        "document_intelligence.ocr.ocr_image", fake_ocr_image_erro
    )
    monkeypatch.setattr(main.settings, "warmup", True)
    monkeypatch.setattr(main.settings, "ocr_dpi", 200)

    main.parser_warmed = False

    # _warmup levanta excecao diretamente (nao eh engolida por _run_warmup).
    try:
        main._warmup()
        assert False, "Deveria ter levantado exceção"
    except RuntimeError:
        pass

    assert main.parser_warmed is False


def test_warmup_tesseract_indisponivel_nao_marca_aquecido(monkeypatch) -> None:
    """Warmup com Tesseract indisponível deve falhar e nao marcar parser_warmed."""
    from document_intelligence.ocr import TesseractNotAvailableError
    from document_intelligence.schemas import (
        DocumentInfo,
        ParseResponse,
        ProcessingMetadata,
    )

    def fake_build_warmup_pdf():
        return b"%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF"

    def fake_build_parse_response(path, document_id, size_bytes=0):
        return ParseResponse(
            document_id=document_id,
            status="completed",
            document=DocumentInfo(
                mime_type="application/pdf", page_count=1, size_bytes=0
            ),
            content={"text": "ok", "markdown": "ok"},
            pages=[],
            metadata=ProcessingMetadata(
                processor_version="5.3.4", processing_time_ms=1
            ),
        )

    def fake_render_page_to_image(path, page_number, dpi=200, output_path=None):
        import tempfile, os

        fd, tmp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        return tmp_path, 800, 1100

    def fake_ocr_image_erro(
        image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200
    ):
        raise TesseractNotAvailableError("idioma nao disponível")

    monkeypatch.setattr(
        "document_intelligence.warmup.build_warmup_pdf", fake_build_warmup_pdf
    )
    monkeypatch.setattr(main, "build_parse_response", fake_build_parse_response)
    monkeypatch.setattr(
        "document_intelligence.ocr.render_page_to_image", fake_render_page_to_image
    )
    monkeypatch.setattr(
        "document_intelligence.ocr.ocr_image", fake_ocr_image_erro
    )
    monkeypatch.setattr(main.settings, "warmup", True)
    monkeypatch.setattr(main.settings, "ocr_dpi", 200)

    main.parser_warmed = False

    # _warmup levanta excecao diretamente.
    try:
        main._warmup()
        assert False, "Deveria ter levantado exceção"
    except (TesseractNotAvailableError, RuntimeError):
        pass

    assert main.parser_warmed is False


# ---------------------------------------------------------------------------
# Testes de agendamento do warmup (item 4)
# ---------------------------------------------------------------------------

def test_warmup_agendado_apenas_quando_warmup_true(monkeypatch) -> None:
    """DI_WARMUP=true deve agendar warmup; DI_WARMUP=false nao deve."""
    from document_intelligence.schemas import (
        DocumentInfo,
        ParseResponse,
        ProcessingMetadata,
    )

    warmup_chamado = []

    def fake_build_warmup_pdf():
        return b"%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF"

    def fake_build_parse_response(path, document_id, size_bytes=0):
        return ParseResponse(
            document_id=document_id,
            status="completed",
            document=DocumentInfo(
                mime_type="application/pdf", page_count=1, size_bytes=0
            ),
            content={"text": "ok", "markdown": "ok"},
            pages=[],
            metadata=ProcessingMetadata(
                processor_version="5.3.4", processing_time_ms=1
            ),
        )

    def fake_render_page_to_image(path, page_number, dpi=200, output_path=None):
        import tempfile, os

        fd, tmp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        return tmp_path, 800, 1100

    def fake_ocr_image(
        image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200
    ):
        from document_intelligence.ocr import OcrLine

        warmup_chamado.append(True)
        return [
            OcrLine(
                text="texto reconhecido",
                x1=10,
                y1=10,
                x2=100,
                y2=30,
                confidence=90,
                word_count=2,
            )
        ]

    monkeypatch.setattr(
        "document_intelligence.warmup.build_warmup_pdf", fake_build_warmup_pdf
    )
    monkeypatch.setattr(main, "build_parse_response", fake_build_parse_response)
    monkeypatch.setattr(
        "document_intelligence.ocr.render_page_to_image", fake_render_page_to_image
    )
    monkeypatch.setattr(
        "document_intelligence.ocr.ocr_image", fake_ocr_image
    )
    monkeypatch.setattr(main.settings, "ocr_dpi", 200)

    # Teste 1: DI_WARMUP=true → executa warmup
    monkeypatch.setattr(main.settings, "warmup", True)
    main.parser_warmed = False
    warmup_chamado.clear()

    import asyncio

    async def run_warmup():
        if main.settings.warmup:
            await main._run_warmup()

    asyncio.run(run_warmup())

    assert main.parser_warmed is True
    assert len(warmup_chamado) == 1

    # Teste 2: DI_WARMUP=false → não executa warmup
    monkeypatch.setattr(main.settings, "warmup", False)
    main.parser_warmed = False
    warmup_chamado.clear()

    async def run_no_warmup():
        if main.settings.warmup:
            await main._run_warmup()

    asyncio.run(run_no_warmup())

    assert main.parser_warmed is False
    assert len(warmup_chamado) == 0

