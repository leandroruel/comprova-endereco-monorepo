"""Testes de tratamento de falha do processador PDF (não carregam o Tesseract)."""

from pathlib import Path

import pytest

from document_intelligence.pdf_processor import build_parse_response


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
