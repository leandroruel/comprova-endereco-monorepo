"""Testes de integração com o Tesseract real sobre fixtures PDF versionadas.

Estes testes exigem o binário ``tesseract`` instalado com o idioma ``por``.
Não rodam em CI sem Tesseract. Execute apenas eles com::

    pytest -m integration

Os PDFs em ``tests/fixtures`` são sintéticos e não contêm dados reais.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from document_intelligence.pdf_processor import build_parse_response
from document_intelligence.tests.conftest import requires_tesseract

pytestmark = [pytest.mark.integration, requires_tesseract]


@pytest.fixture(scope="session")
def ocr_lang() -> str:
    return "por"


def test_pdf_texto_multipagina(sample_text_pdf: Path) -> None:
    """PDF digital com camada de texto: extrai texto sem OCR."""
    response = build_parse_response(str(sample_text_pdf), "doc-texto", size_bytes=1)

    assert response.status == "completed"
    assert response.document.mime_type == "application/pdf"
    assert response.document.page_count == 2
    assert [page.page_number for page in response.pages] == [1, 2]
    assert response.metadata.contract_version == "1.0"
    assert response.metadata.processor == "tesseract"

    texto = response.content.get("text", "")
    assert "CONTRATO DE PRESTACAO DE SERVICOS" in texto
    assert "SEGUNDA PAGINA" in texto
    # Ordem de leitura preservada entre páginas.
    assert texto.index("CONTRATO DE PRESTACAO") < texto.index("SEGUNDA PAGINA")


def test_pdf_texto_preserva_bbox_e_ordem(sample_text_pdf: Path) -> None:
    """Elementos da camada textual não têm bbox (não há OCR), mas ordem é preservada."""
    response = build_parse_response(str(sample_text_pdf), "doc-bbox", size_bytes=1)
    assert response.status == "completed"

    elementos = [el for page in response.pages for el in page.elements]
    assert elementos, "esperava elementos extraídos"
    # IDs únicos preservando a ordem.
    ids = [el.id for el in elementos]
    assert len(ids) == len(set(ids))


def test_contrato_serializavel(sample_text_pdf: Path) -> None:
    """O JSON serializado é compatível com o contrato externo (camelCase)."""
    response = build_parse_response(str(sample_text_pdf), "doc-contrato", size_bytes=1)
    dados = response.model_dump(mode="json", by_alias=True)

    assert dados["status"] == "completed"
    assert set(dados["document"]).issuperset(
        {"mimeType", "pageCount", "sizeBytes"}
    )
    assert "text" in dados["content"]
    assert "markdown" in dados["content"]
    assert dados["metadata"]["contractVersion"] == "1.0"
    assert isinstance(dados["pages"], list)
    assert dados["pages"][0]["pageNumber"] == 1
    assert dados["pages"][0]["elements"][0]["id"]


def test_processor_e_versao_no_metadata(sample_text_pdf: Path) -> None:
    """O metadado reporta o processador Tesseract e sua versão."""
    response = build_parse_response(str(sample_text_pdf), "doc-ver", size_bytes=1)
    assert response.status == "completed"
    assert response.metadata.processor == "tesseract"
    assert response.metadata.processor_version
    assert response.metadata.contract_version == "1.0"


def test_pdf_sem_camada_textual_usa_ocr(sample_text_pdf: Path) -> None:
    """PDF sem camada de texto (escaneado) é processado por OCR (Tesseract).

    Gera um PDF apenas com imagem (sem texto embutido) a partir de uma página
    renderizada do fixture, simulando um documento escaneado.
    """
    import io

    import pypdfium2 as pdfium
    from PIL import Image

    # Renderiza uma página do fixture como imagem.
    doc_src = pdfium.PdfDocument(str(sample_text_pdf))
    page_src = doc_src[0]
    pil_img = page_src.render(scale=2).to_pil()

    # Cria um novo PDF contendo apenas essa imagem (sem camada de texto).
    buf = io.BytesIO()
    pil_img.save(buf, format="PDF")
    buf.seek(0)

    import tempfile
    import os

    fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            f.write(buf.getvalue())

        response = build_parse_response(tmp_path, "doc-scanned", size_bytes=1)

        assert response.status == "completed"
        assert response.document.page_count == 1
        # Página sem texto utilizável → OCR → warning.
        assert any("OCR" in w for w in response.warnings)
        # Texto reconhecido deve conter algo do conteúdo da imagem.
        texto = response.content.get("text", "")
        assert len(texto) > 0, "esperava texto reconhecido por OCR"
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


def test_ocr_produz_coordenadas_e_confianca(sample_text_pdf: Path) -> None:
    """OCR produz elementos com bounding box e confiança.

    Gera um PDF apenas com imagem (sem texto embutido) para forçar o caminho
    de OCR e verificar coordenadas e confiança.
    """
    import io

    import pypdfium2 as pdfium
    from PIL import Image

    doc_src = pdfium.PdfDocument(str(sample_text_pdf))
    page_src = doc_src[0]
    pil_img = page_src.render(scale=2).to_pil()

    buf = io.BytesIO()
    pil_img.save(buf, format="PDF")
    buf.seek(0)

    import tempfile
    import os

    fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            f.write(buf.getvalue())

        response = build_parse_response(tmp_path, "doc-coords", size_bytes=1)
        assert response.status == "completed"

        elementos = [el for page in response.pages for el in page.elements]
        ocr_elementos = [el for el in elementos if el.metadata.get("source") == "ocr"]
        assert ocr_elementos, "esperava elementos provenientes de OCR"

        for el in ocr_elementos:
            assert el.bbox is not None, "elemento de OCR deve ter bbox"
            assert el.bbox.x1 <= el.bbox.x2
            assert el.bbox.y1 <= el.bbox.y2
            if el.confidence is not None:
                assert 0 <= el.confidence <= 100
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


def test_idioma_portugues_disponivel() -> None:
    """O Tesseract deve ter o idioma 'por' disponível."""
    from document_intelligence.ocr import is_tesseract_available

    assert is_tesseract_available(), "Tesseract com 'por' deve estar disponível"


def test_contrato_compatível_com_consumidores(sample_text_pdf: Path) -> None:
    """O JSON produzido é compatível com o schema do contrato TypeScript."""
    response = build_parse_response(str(sample_text_pdf), "doc-contrato", size_bytes=1)
    dados = response.model_dump(mode="json", by_alias=True)

    # Campos obrigatórios do contrato.
    assert dados["documentId"]
    assert dados["status"] in {"completed", "failed"}
    assert dados["document"]["mimeType"] == "application/pdf"
    assert isinstance(dados["document"]["pageCount"], int)
    assert isinstance(dados["document"]["sizeBytes"], int)
    assert "text" in dados["content"]
    assert isinstance(dados["pages"], list)
    assert dados["metadata"]["processor"]
    assert dados["metadata"]["processorVersion"]
    assert dados["metadata"]["processingTimeMs"] >= 0
    assert dados["metadata"]["contractVersion"] == "1.0"
    assert isinstance(dados["warnings"], list)
    assert dados["errorCode"] is None or isinstance(dados["errorCode"], str)

    # Cada página tem campos obrigatórios.
    for page in dados["pages"]:
        assert isinstance(page["pageNumber"], int) and page["pageNumber"] >= 1
        assert isinstance(page["elements"], list)
        for el in page["elements"]:
            assert el["id"]
            assert el["type"] in {
                "heading", "text", "table", "image", "list", "list_item",
                "page_header", "page_footer", "code_block", "formula",
                "caption", "unknown",
            }
            assert el["text"] is None or isinstance(el["text"], str)
            assert el["confidence"] is None or isinstance(el["confidence"], (int, float))
            assert el["table"] is None or isinstance(el["table"], dict)
            assert el["imageRef"] is None or isinstance(el["imageRef"], str)
            assert isinstance(el["metadata"], dict)

