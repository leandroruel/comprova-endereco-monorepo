"""Testes de OCR: conversao de DPI e verificacao de idioma (sem carregar Tesseract)."""

from __future__ import annotations

from document_intelligence.ocr import OcrWord, _words_to_lines, is_tesseract_available


def test_conversao_dpi_200_equivale_a_pontos_pdf() -> None:
    """A 200 DPI, 100 px deve resultar em 36 pts (100 * 72 / 200)."""
    words = [
        OcrWord(
            text="teste",
            left=100,
            top=200,
            width=50,
            height=20,
            confidence=90,
            block_num=1,
            par_num=1,
            line_num=1,
            word_num=1,
        )
    ]
    lines = _words_to_lines(words, page_width_px=612, page_height_px=792, dpi=200)
    assert len(lines) == 1
    # x1 = 100 * 72 / 200 = 36.0
    assert lines[0].x1 == 36.0
    # x2 = (100 + 50) * 72 / 200 = 54.0
    assert lines[0].x2 == 54.0


def test_conversao_dpi_300_equivale_a_pontos_pdf() -> None:
    """A 300 DPI, 100 px deve resultar em 24 pts (100 * 72 / 300)."""
    words = [
        OcrWord(
            text="teste",
            left=100,
            top=200,
            width=50,
            height=20,
            confidence=90,
            block_num=1,
            par_num=1,
            line_num=1,
            word_num=1,
        )
    ]
    lines = _words_to_lines(words, page_width_px=612, page_height_px=792, dpi=300)
    assert len(lines) == 1
    # x1 = 100 * 72 / 300 = 24.0
    assert lines[0].x1 == 24.0
    # x2 = (100 + 50) * 72 / 300 = 36.0
    assert lines[0].x2 == 36.0


def test_conversao_dpi_400_equivale_a_pontos_pdf() -> None:
    """A 400 DPI, 100 px deve resultar em 18 pts (100 * 72 / 400)."""
    words = [
        OcrWord(
            text="teste",
            left=100,
            top=200,
            width=50,
            height=20,
            confidence=90,
            block_num=1,
            par_num=1,
            line_num=1,
            word_num=1,
        )
    ]
    lines = _words_to_lines(words, page_width_px=612, page_height_px=792, dpi=400)
    assert len(lines) == 1
    # x1 = 100 * 72 / 400 = 18.0
    assert lines[0].x1 == 18.0
    # x2 = (100 + 50) * 72 / 400 = 27.0
    assert lines[0].x2 == 27.0


def test_mesma_posicao_fisica_produz_mesmos_pontos_pdf() -> None:
    """Mesma posicao física da página produz coordenadas PDF equivalentes
    independentemente do DPI usado na renderização."""
    # Altura da página em pontos PDF: 792 pt.
    # Em pixels: 792 * dpi / 72.
    page_height_px_200 = int(792 * 200 / 72)  # 2200
    page_height_px_300 = int(792 * 300 / 72)  # 3300

    words_200 = [
        OcrWord(
            text="x",
            left=200,
            top=100,
            width=10,
            height=10,
            confidence=90,
            block_num=1,
            par_num=1,
            line_num=1,
            word_num=1,
        )
    ]
    words_300 = [
        OcrWord(
            text="x",
            left=300,  # mesmo ponto físico: 300 px a 300 DPI = 200 px a 200 DPI
            top=150,   # mesmo ponto físico: 150 px a 300 DPI = 100 px a 200 DPI
            width=15,  # 15 px a 300 DPI = 10 px a 200 DPI
            height=15, # 15 px a 300 DPI = 10 px a 200 DPI
            confidence=90,
            block_num=1,
            par_num=1,
            line_num=1,
            word_num=1,
        )
    ]
    lines_200 = _words_to_lines(words_200, 612, page_height_px_200, dpi=200)
    lines_300 = _words_to_lines(words_300, 612, page_height_px_300, dpi=300)

    assert lines_200[0].x1 == lines_300[0].x1
    assert lines_200[0].y1 == lines_300[0].y1
    assert lines_200[0].x2 == lines_300[0].x2
    assert lines_200[0].y2 == lines_300[0].y2


def test_idioma_disponivel_retorna_true() -> None:
    """Idioma instalado ('por') deve retornar True."""
    assert is_tesseract_available("por") is True


def test_idioma_inexistente_retorna_false() -> None:
    """Idioma nao instalado deve retornar False."""
    assert is_tesseract_available("idioma_que_nao_existe") is False


def test_idioma_default_e_por() -> None:
    """O idioma default deve ser 'por' e disponível."""
    assert is_tesseract_available() is True
