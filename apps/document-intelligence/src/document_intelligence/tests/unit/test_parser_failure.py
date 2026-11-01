"""Testes do tratamento de falha do Marker (não carregam modelos)."""

from document_intelligence.parser import MarkerParser


class _FailingConverter:
    def build_document(self, path: str) -> None:  # noqa: ARG002 - assinatura
        raise RuntimeError("falha interna com conteudo sensivel do documento")


def test_parser_retorna_failed_sem_vazar_detalhes(tmp_path) -> None:
    pdf = tmp_path / "documento.pdf"
    pdf.write_bytes(b"%PDF-1.7\nconteudo")

    parser = MarkerParser()
    # Evita carregar os modelos: injeta um converter que falha.
    parser._loaded = True  # noqa: SLF001 (teste)
    parser._converter = _FailingConverter()  # noqa: SLF001 (teste)

    response = parser.parse(str(pdf), "doc-falha", size_bytes=10)

    assert response.status == "failed"
    assert response.error_code == "MARKER_FAILED"
    assert response.document.page_count == 0
    assert response.pages == []
    assert response.content == {}
    # A mensagem interna (que poderia conter conteúdo) não é propagada.
    assert "sensivel" not in (response.error_message or "")
    assert response.error_message is not None
