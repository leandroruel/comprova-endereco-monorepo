"""Testes de OCR: conversao de DPI e verificacao de idioma."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from document_intelligence.ocr import (
    OcrWord,
    TesseractNotAvailableError,
    _words_to_lines,
    is_tesseract_available,
    ocr_image,
)
from document_intelligence.tests.conftest import requires_tesseract


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
    assert lines[0].x1 == 36.0
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
    assert lines[0].x1 == 24.0
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
    assert lines[0].x1 == 18.0
    assert lines[0].x2 == 27.0


def test_mesma_posicao_fisica_produz_mesmos_pontos_pdf() -> None:
    """Mesma posicao física da página produz coordenadas PDF equivalentes
    independentemente do DPI usado na renderização."""
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
            left=300,
            top=150,
            width=15,
            height=15,
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


@requires_tesseract
def test_idioma_disponivel_retorna_true() -> None:
    """Idioma instalado ('por') deve retornar True."""
    assert is_tesseract_available("por") is True


def test_idioma_inexistente_retorna_false() -> None:
    """Idioma nao instalado deve retornar False."""
    assert is_tesseract_available("idioma_que_nao_existe") is False


@requires_tesseract
def test_idioma_default_e_por() -> None:
    """O idioma default deve ser 'por' e disponível."""
    assert is_tesseract_available() is True


@requires_tesseract
def test_ocr_image_verifica_idioma_solicitado() -> None:
    """ocr_image deve verificar o idioma exato passado, não apenas o default.

    Verifica que o idioma passado para ocr_image() é exatamente o utilizado
    tanto na validação de disponibilidade quanto na execução do Tesseract.
    """
    chamados_validacao = []
    chamados_execucao = []

    def fake_available(lang="por"):
        chamados_validacao.append(lang)
        return True

    def fake_tsv(image_path, lang="por", **kwargs):
        chamados_execucao.append(lang)
        return (
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\t"
            "left\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t100\t100\t50\t20\t90\thello\n"
        )

    with patch(
        "document_intelligence.ocr.is_tesseract_available", side_effect=fake_available
    ), patch(
        "document_intelligence.ocr._run_tesseract_tsv", side_effect=fake_tsv
    ), patch(
        "document_intelligence.ocr._tesseract_binary",
        return_value="/usr/bin/tesseract",
    ):
        lines = ocr_image("/fake/path.png", lang="eng")
        assert "eng" in chamados_validacao
        assert "eng" in chamados_execucao
        assert len(lines) == 1

    chamados_validacao.clear()
    chamados_execucao.clear()
    with patch(
        "document_intelligence.ocr.is_tesseract_available", side_effect=fake_available
    ), patch(
        "document_intelligence.ocr._run_tesseract_tsv", side_effect=fake_tsv
    ), patch(
        "document_intelligence.ocr._tesseract_binary",
        return_value="/usr/bin/tesseract",
    ):
        lines = ocr_image("/fake/path.png", lang="por")
        assert "por" in chamados_validacao
        assert "por" in chamados_execucao


@requires_tesseract
def test_ocr_image_idioma_indisponivel_erro() -> None:
    """ocr_image deve levantar TesseractNotAvailableError quando idioma não instalado.

    A mensagem de erro deve identificar o idioma solicitado.
    """
    with patch(
        "document_intelligence.ocr.is_tesseract_available", return_value=False
    ), patch(
        "document_intelligence.ocr._tesseract_binary",
        return_value="/usr/bin/tesseract",
    ):
        try:
            ocr_image("/fake/path.png", lang="idioma_inexistente")
            assert False, "Deveria ter levantado TesseractNotAvailableError"
        except TesseractNotAvailableError as exc:
            assert "idioma_inexistente" in str(exc)
