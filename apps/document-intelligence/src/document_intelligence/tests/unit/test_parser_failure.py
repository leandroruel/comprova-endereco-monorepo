"""Testes de tratamento de falha do processador PDF (não carregam o Tesseract)."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from document_intelligence.pdf_processor import (
    _MIN_TEXT_LAYER_FOR_FULL_PAGE,
    _ocr_page,
    _page_has_images,
    _process_pdf_pages,
    _PageTextResult,
    build_parse_response,
)

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


def test_processor_retorna_failed_para_pdf_inexistente(tmp_path) -> None:
    """PDF que não existe deve resultar em status 'failed' sem vazar detalhes."""
    pdf = tmp_path / "nao_existe.pdf"

    response = build_parse_response(str(pdf), "doc-falha", size_bytes=10)

    assert response.status == "failed"
    assert response.error_code == "PROCESSING_FAILED"
    assert response.document.page_count == 0
    assert response.pages == []
    assert response.content == {}
    # A mensagem interna não é propagada para o consumidor.
    assert response.error_message is not None
    assert "nao_existe" not in (response.error_message or "")


def test_processor_retorna_failed_para_arquivo_nao_pdf(tmp_path) -> None:
    """Arquivo sem assinatura PDF resulta em falha de validação (SecurityError)."""
    pdf = tmp_path / "nao_eh_pdf.pdf"
    pdf.write_bytes(b"isso nao e um pdf")

    response = build_parse_response(str(pdf), "doc-nao-pdf", size_bytes=10)

    assert response.status == "failed"
    assert response.document.page_count == 0


def test_processor_caminho_pdf_vazio_nao_tem_paginas(tmp_path) -> None:
    """PDF válido mas sem páginas resulta em erro de segurança."""
    pdf = tmp_path / "vazio.pdf"
    pdf.write_bytes(b"%PDF-1.7\n%%EOF")

    response = build_parse_response(str(pdf), "doc-vazio", size_bytes=10)

    assert response.status == "failed"
    assert response.document.page_count == 0


def test_page_has_images_retorna_false_para_pdf_apenas_texto(
    sample_text_pdf: Path,
) -> None:
    """PDF com apenas camada textual nao deve ser detectado como tendo imagens."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(sample_text_pdf))
    try:
        assert _page_has_images(document, 0) is False
    finally:
        document.close()


def test_page_has_images_retorna_true_para_pdf_com_imagem(
    sample_image_pdf: Path,
) -> None:
    """PDF com imagem embutida deve ser detectado como tendo imagens."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(sample_image_pdf))
    try:
        assert _page_has_images(document, 0) is True
    finally:
        document.close()


def test_process_pdf_pages_apenas_texto_usa_caminho_rapido(
    sample_text_pdf: Path,
) -> None:
    """PDF totalmente digital deve processar apenas pela camada textual, sem OCR."""
    from document_intelligence.pdf_processor import _ocr_page

    ocr_called = False

    def fake_ocr_page(document, page_index, page_number):
        nonlocal ocr_called
        ocr_called = True
        return _ocr_page(document, page_index, page_number)

    with patch(
        "document_intelligence.pdf_processor._ocr_page", side_effect=fake_ocr_page
    ):
        results, page_count, any_ocr = _process_pdf_pages(str(sample_text_pdf))

    assert page_count == 2
    assert any_ocr is False
    assert ocr_called is False
    assert len(results) == 2
    # Todas as paginas devem usar a camada textual.
    assert all(r.source == "text_layer" for r in results)


def test_process_pdf_pages_apenas_imagem_usa_ocr(
    sample_image_pdf: Path,
) -> None:
    """PDF apenas com imagem (escaneado) deve processar via OCR."""
    results, page_count, any_ocr = _process_pdf_pages(str(sample_image_pdf))

    assert page_count == 1
    assert any_ocr is True
    assert len(results) == 1
    assert results[0].source == "ocr"


def test_pagina_mista_texto_curto_com_imagem_executa_ocr(
    monkeypatch, tmp_path
) -> None:
    """Pagina com texto curto (< 100 chars) e imagem deve executar OCR (caminho misto).

    Monkeypatch _page_image_area_ratio para retornar um valor acima do
    limiar e _ocr_page para evitar chamada real ao Tesseract. Verifica que o
    resultado combina texto da camada com texto do OCR, preservando a fonte
    'mixed'.
    """
    from document_intelligence.tests.fixtures.generate_fixtures import build_pdf
    from document_intelligence import pdf_processor
    from document_intelligence.pdf_processor import _PageTextResult

    # Cria PDF com texto curto (13 chars, abaixo de _MIN_TEXT_LAYER_FOR_FULL_PAGE=100).
    short_pdf_bytes = build_pdf([["COMPROVANTE"]])
    short_pdf = tmp_path / "curto.pdf"
    short_pdf.write_bytes(short_pdf_bytes)

    # Monkeypatch _page_image_area_ratio para simular imagem relevante na pagina.
    monkeypatch.setattr(
        pdf_processor, "_page_image_area_ratio", lambda doc, idx: 0.5
    )

    # Monkeypatch _ocr_page para evitar chamada real ao Tesseract.
    ocr_calls = []

    def fake_ocr_page(document, page_index, page_number):
        ocr_calls.append((page_index, page_number))
        return _PageTextResult(
            page_number=page_number,
            text="texto do OCR",
            elements=[],
            width=612,
            height=792,
            source="ocr",
        )

    monkeypatch.setattr(pdf_processor, "_ocr_page", fake_ocr_page)

    results, page_count, any_ocr = _process_pdf_pages(str(short_pdf))

    assert page_count == 1
    assert any_ocr is True
    # OCR deve ser chamado (texto curto + imagem relevante).
    assert len(ocr_calls) == 1
    # O resultado deve ter fonte "mixed" e conter texto do OCR.
    assert results[0].source == "mixed"
    assert "texto do OCR" in results[0].text
    # Texto da camada tambem deve ser preservado.
    assert "COMPROVANTE" in results[0].text


def test_temp_arquivos_removidos_em_sucesso(monkeypatch, tmp_path) -> None:
    """Arquivos temporarios (original + preprocessado) devem ser removidos no sucesso."""
    import pypdfium2 as pdfium
    import tempfile
    from document_intelligence import pdf_processor

    # Cria um PDF de 1 pagina com texto para nao exigir Tesseract no OCR real.
    # Mas _ocr_page sempre chama o Tesseract, entao vamos monkeypatchar.
    created_paths = []
    _original_mkstemp = tempfile.mkstemp

    def fake_mkstemp(prefix, suffix, dir=None):
        fd, path = _original_mkstemp(prefix=prefix, suffix=suffix, dir=dir)
        created_paths.append(path)
        # Nao fecha o fd: _ocr_page fecha apos salvar a imagem.
        return fd, path

    monkeypatch.setattr(tempfile, "mkstemp", fake_mkstemp)

    def fake_ocr_image(image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200):
        return []

    monkeypatch.setattr(pdf_processor, "ocr_image", fake_ocr_image)

    # Habilita preprocessing para testar que ambos os caminhos sao limpos.
    monkeypatch.setattr(pdf_processor.settings, "ocr_preprocess", True)

    def fake_preprocess(image_path):
        preprocessed = image_path.replace(".png", "_preprocessed.png")
        # Cria o arquivo preprocessado simulando o OpenCV.
        with open(preprocessed, "wb") as f:
            f.write(b"fake preprocessed")
        return preprocessed

    monkeypatch.setattr(
        "document_intelligence.ocr.preprocess_image_for_ocr", fake_preprocess
    )

    document = pdfium.PdfDocument(
        str(FIXTURES_DIR / "sample_text.pdf")
    )
    try:
        result = _ocr_page(document, 0, 1)
    finally:
        document.close()

    # Ambos os arquivos devem ter sido removidos.
    for path in created_paths:
        assert not os.path.exists(path), f"arquivo temporario nao removido: {path}"
    # O arquivo preprocessado tambem deve existir na lista e ser removido.
    preprocessed = created_paths[0].replace(".png", "_preprocessed.png")
    assert not os.path.exists(preprocessed), "arquivo preprocessado nao removido"


def test_temp_arquivos_removidos_em_falha_ocr(monkeypatch, tmp_path) -> None:
    """Arquivos temporarios devem ser removidos mesmo quando o OCR falha."""
    import pypdfium2 as pdfium
    import tempfile
    from document_intelligence import pdf_processor

    created_paths = []
    _original_mkstemp = tempfile.mkstemp

    def fake_mkstemp(prefix, suffix, dir=None):
        fd, path = _original_mkstemp(prefix=prefix, suffix=suffix, dir=dir)
        created_paths.append(path)
        # Nao fecha o fd: _ocr_page fecha apos salvar a imagem.
        return fd, path

    monkeypatch.setattr(tempfile, "mkstemp", fake_mkstemp)

    def fake_ocr_image_raises(image_path, lang="por", page_width_px=None, page_height_px=None, dpi=200):
        raise RuntimeError("tesseract falhou")

    monkeypatch.setattr(pdf_processor, "ocr_image", fake_ocr_image_raises)

    monkeypatch.setattr(pdf_processor.settings, "ocr_preprocess", True)

    def fake_preprocess(image_path):
        preprocessed = image_path.replace(".png", "_preprocessed.png")
        with open(preprocessed, "wb") as f:
            f.write(b"fake preprocessed")
        return preprocessed

    monkeypatch.setattr(
        "document_intelligence.ocr.preprocess_image_for_ocr", fake_preprocess
    )

    document = pdfium.PdfDocument(
        str(FIXTURES_DIR / "sample_text.pdf")
    )
    try:
        with pytest.raises(RuntimeError, match="tesseract falhou"):
            _ocr_page(document, 0, 1)
    finally:
        document.close()

    # Mesmo com falha, ambos os arquivos devem ser removidos.
    for path in created_paths:
        assert not os.path.exists(path), f"arquivo temporario nao removido apos falha: {path}"
    preprocessed = created_paths[0].replace(".png", "_preprocessed.png")
    assert not os.path.exists(preprocessed), "arquivo preprocessado nao removido apos falha"


def test_pagina_mista_texto_longo_com_imagem_relevante_executa_ocr(
    monkeypatch, tmp_path
) -> None:
    """Pagina com texto longo (> 100 chars) + imagem relevante deve executar OCR.

    Este teste e especialmente importante: demonstra que dados existentes
    exclusivamente na imagem sao recuperados mesmo quando a camada textual
    ultrapassa 100 caracteres. A detecção antiga (baseada apenas no tamanho
    do texto) ignoraria OCR neste caso.
    """
    from document_intelligence.tests.fixtures.generate_fixtures import build_pdf
    from document_intelligence import pdf_processor
    from document_intelligence.pdf_processor import _PageTextResult

    # Texto longo (mais de 100 chars) na camada digital.
    long_text_pdf_bytes = build_pdf(
        [
            [
                "COMPROVANTE DE RESIDENCIA - DISTRIBUIDORA DE ENERGIA DEMO",
                "CNPJ: 00.000.000/0001-00",
                "Titular: Maria da Silva",
                "Endereco: RUA DAS FLORES, 123, Centro, Sao Paulo, SP",
                "CEP: 01001-000",
                "Vencimento: 10/11/2026",
                "Valor: R$ 150,00",
                "Este e um texto longo na camada digital para simular um "
                "documento com cabeçalho e informacoes institucionais "
                "selecionaveis, mas com dados relevantes apenas na imagem.",
            ]
        ]
    )
    long_text_pdf = tmp_path / "texto_longo.pdf"
    long_text_pdf.write_bytes(long_text_pdf_bytes)

    ocr_calls = []
    ocr_text_from_image = "Titular: Maria da Silva Endereco: RUA DAS FLORES, 123 CEP: 01001-000"

    def fake_ocr_page(document, page_index, page_number):
        ocr_calls.append((page_index, page_number))
        return _PageTextResult(
            page_number=page_number,
            text=ocr_text_from_image,
            elements=[],
            width=612,
            height=792,
            source="ocr",
        )

    monkeypatch.setattr(pdf_processor, "_page_image_area_ratio", lambda doc, idx: 0.5)
    monkeypatch.setattr(pdf_processor, "_ocr_page", fake_ocr_page)

    results, page_count, any_ocr = _process_pdf_pages(str(long_text_pdf))

    assert page_count == 1
    assert any_ocr is True
    assert len(ocr_calls) == 1
    assert results[0].source == "mixed"
    # Dados da imagem devem aparecer no resultado final.
    assert ocr_text_from_image in results[0].text
    # Texto da camada digital tambem deve ser preservado.
    assert "DISTRIBUIDORA DE ENERGIA DEMO" in results[0].text


def test_pdf_digital_imagem_decorativa_preserva_caminho_rapido(
    monkeypatch, tmp_path
) -> None:
    """PDF digital com imagem pequena/decorativa deve usar apenas a camada textual.

    Quando a imagem ocupa menos que _MIN_IMAGE_AREA_RATIO (15%) da pagina,
    ela e considerada decorativa e o OCR nao e executado.
    """
    from document_intelligence.tests.fixtures.generate_fixtures import build_pdf
    from document_intelligence import pdf_processor

    # Texto longo na camada digital.
    long_text_pdf_bytes = build_pdf(
        [
            [
                "COMPROVANTE DE RESIDENCIA",
                "Titular: Usuario Teste",
                "Endereco: RUA X, 100",
                "CEP: 01001-000",
            ]
        ]
    )
    long_text_pdf = tmp_path / "decorativa.pdf"
    long_text_pdf.write_bytes(long_text_pdf_bytes)

    ocr_called = False

    def fake_ocr_page(document, page_index, page_number):
        nonlocal ocr_called
        ocr_called = True
        from document_intelligence.pdf_processor import _PageTextResult

        return _PageTextResult(
            page_number=page_number,
            text="texto do OCR",
            elements=[],
            width=612,
            height=792,
            source="ocr",
        )

    # Imagem pequena (5% da area) - considerada decorativa.
    monkeypatch.setattr(pdf_processor, "_page_image_area_ratio", lambda doc, idx: 0.05)
    monkeypatch.setattr(pdf_processor, "_ocr_page", fake_ocr_page)

    results, page_count, any_ocr = _process_pdf_pages(str(long_text_pdf))

    assert page_count == 1
    assert any_ocr is False
    assert ocr_called is False
    assert results[0].source == "text_layer"
    # Texto da camada digital deve estar presente.
    assert "COMPROVANTE DE RESIDENCIA" in results[0].text


