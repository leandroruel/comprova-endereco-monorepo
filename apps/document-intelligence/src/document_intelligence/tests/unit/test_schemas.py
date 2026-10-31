"""Testes unitários dos schemas do contrato JSON (não dependem do Marker)."""

from document_intelligence.schemas import (
    BBox,
    DocumentElement,
    DocumentInfo,
    Page,
    ParseResponse,
    ProcessingMetadata,
    Table,
    TableCell,
)


def test_parse_response_serializacao() -> None:
    resposta = ParseResponse(
        document_id="abc123",
        status="completed",
        document=DocumentInfo(
            mime_type="application/pdf",
            page_count=2,
            size_bytes=1234,
        ),
        content={"text": "ola mundo", "markdown": "# ola mundo"},
        pages=[
            Page(
                page_number=1,
                elements=[
                    DocumentElement(
                        id="abc123-p1-b1",
                        type="heading",
                        text="Titulo",
                        bbox=BBox(x1=10, y1=20, x2=100, y2=40),
                        confidence=0.95,
                    )
                ],
            )
        ],
        metadata=ProcessingMetadata(
            processor_version="2.1.0",
            processing_time_ms=150,
        ),
    )
    dados = resposta.model_dump()
    assert dados["document_id"] == "abc123"
    assert dados["status"] == "completed"
    assert dados["document"]["page_count"] == 2
    assert dados["pages"][0]["elements"][0]["type"] == "heading"
    assert dados["metadata"]["contract_version"] == "1.0"

    # JSON HTTP usa aliases camelCase (contrato externo).
    externo = resposta.model_dump(by_alias=True)
    assert externo["documentId"] == "abc123"
    assert externo["document"]["pageCount"] == 2
    assert externo["metadata"]["contractVersion"] == "1.0"
    assert externo["metadata"]["processingTimeMs"] == 150


def test_table_celula_e_estrutura() -> None:
    tabela = Table(
        headers=["Coluna 1", "Coluna 2"],
        rows=[["A", "B"], ["C", "D"]],
        cells=[
            TableCell(text="A", row=0, column=0),
            TableCell(text="B", row=0, column=1),
        ],
        bbox=BBox(x1=0, y1=0, x2=100, y2=20),
    )
    assert tabela.headers == ["Coluna 1", "Coluna 2"]
    assert tabela.rows[0] == ["A", "B"]
    assert tabela.cells[0].rowspan == 1
