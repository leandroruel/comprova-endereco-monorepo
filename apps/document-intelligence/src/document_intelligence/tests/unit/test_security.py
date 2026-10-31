"""Testes unitários do módulo de segurança (não dependem do Marker)."""

import os

import pytest

from document_intelligence.security import (
    SecurityError,
    generate_document_id,
    temporary_pdf_path,
    validate_uploaded_pdf,
)

PDF_HEADER = b"%PDF-1.7\n"


def _make_pdf(body: bytes = b"conteudo qualquer") -> bytes:
    return PDF_HEADER + body


def test_valida_pdf_valido() -> None:
    uploaded = validate_uploaded_pdf(
        data=_make_pdf(),
        filename="documento.pdf",
        declared_content_type="application/pdf",
        max_size_bytes=10 * 1024 * 1024,
    )
    assert uploaded.filename == "documento.pdf"
    assert uploaded.detected_content_type == "application/pdf"
    assert uploaded.size_bytes == len(_make_pdf())


def test_rejeita_arquivo_vazio() -> None:
    with pytest.raises(SecurityError, match="vazio"):
        validate_uploaded_pdf(
            data=b"",
            filename="vazio.pdf",
            declared_content_type="application/pdf",
            max_size_bytes=10 * 1024 * 1024,
        )


def test_rejeita_sem_assinatura_pdf() -> None:
    with pytest.raises(SecurityError, match="assinatura"):
        validate_uploaded_pdf(
            data=b"isso nao e um pdf",
            filename="falso.pdf",
            declared_content_type="application/pdf",
            max_size_bytes=10 * 1024 * 1024,
        )


def test_rejeita_tamanho_acima_do_limite() -> None:
    dados = _make_pdf(body=b"x" * (11 * 1024 * 1024))
    with pytest.raises(SecurityError, match="excede"):
        validate_uploaded_pdf(
            data=dados,
            filename="grande.pdf",
            declared_content_type="application/pdf",
            max_size_bytes=10 * 1024 * 1024,
        )


def test_rejeita_path_traversal_no_nome() -> None:
    with pytest.raises(SecurityError, match="componentes de diret"):
        validate_uploaded_pdf(
            data=_make_pdf(),
            filename="../etc/passwd.pdf",
            declared_content_type="application/pdf",
            max_size_bytes=10 * 1024 * 1024,
        )


def test_generate_document_id_nao_vazio_e_aleatorio() -> None:
    id1 = generate_document_id()
    id2 = generate_document_id()
    assert id1 != id2
    assert len(id1) > 0


def test_temporary_pdf_path_limpa_apos_uso() -> None:
    caminho: str | None = None
    with temporary_pdf_path(b"%PDF-1.4\nteste") as path:
        caminho = path
        assert os.path.exists(path)  # noqa: PTH112 (teste intencional)
    assert caminho is not None
    assert not os.path.exists(caminho)  # noqa: PTH112 (teste intencional)


def test_inspect_pdf_conta_paginas(sample_text_pdf) -> None:
    from document_intelligence.security import inspect_pdf

    assert inspect_pdf(str(sample_text_pdf)) == 2


def test_inspect_pdf_respeita_limite_de_paginas(sample_text_pdf) -> None:
    from document_intelligence.security import PageLimitError, inspect_pdf

    with pytest.raises(PageLimitError, match="limite"):
        inspect_pdf(str(sample_text_pdf), max_pages=1)


def test_inspect_pdf_rejeita_corrompido(tmp_path) -> None:
    from document_intelligence.security import SecurityError, inspect_pdf

    caminho = tmp_path / "corrompido.pdf"
    caminho.write_bytes(b"%PDF-1.7\nsem xref nem trailer")
    with pytest.raises(SecurityError):
        inspect_pdf(str(caminho))
