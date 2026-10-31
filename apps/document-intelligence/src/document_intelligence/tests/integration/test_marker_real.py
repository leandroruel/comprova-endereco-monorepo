"""Testes de integração com o Marker real sobre fixtures PDF versionadas.

Estes testes exigem o pacote ``marker-pdf`` e seus modelos. Na primeira
execução, os pesos são baixados do Hugging Face; portanto não rodam em CI sem
rede/modelos. Execute apenas eles com::

    pytest -m integration

Os PDFs em ``tests/fixtures`` são sintéticos e não contêm dados reais.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from document_intelligence.parser import CONTRACT_VERSION
from document_intelligence.tests.conftest import requires_marker

pytestmark = [pytest.mark.integration, requires_marker]


@pytest.fixture(scope="session")
def parser():
    from document_intelligence.parser import MarkerParser

    instance = MarkerParser()
    instance.load_models()
    return instance


def test_pdf_texto_multipagina(parser, sample_text_pdf: Path) -> None:
    response = parser.parse(str(sample_text_pdf), "doc-texto", size_bytes=1)

    assert response.status == "completed"
    assert response.document.mime_type == "application/pdf"
    assert response.document.page_count == 2
    assert [page.page_number for page in response.pages] == [1, 2]
    assert response.metadata.contract_version == CONTRACT_VERSION
    assert response.metadata.processor == "marker"

    texto = response.content.get("text", "")
    assert "CONTRATO DE PRESTACAO DE SERVICOS" in texto
    assert "SEGUNDA PAGINA" in texto
    # Ordem de leitura preservada entre páginas.
    assert texto.index("CONTRATO DE PRESTACAO") < texto.index("SEGUNDA PAGINA")


def test_pdf_texto_preserva_bbox_e_ordem(parser, sample_text_pdf: Path) -> None:
    response = parser.parse(str(sample_text_pdf), "doc-bbox", size_bytes=1)
    assert response.status == "completed"

    elementos = [el for page in response.pages for el in page.elements]
    assert elementos, "esperava elementos extraídos"
    # Coordenadas presentes e ordenadas.
    com_bbox = [el for el in elementos if el.bbox is not None]
    assert com_bbox, "esperava elementos com bbox"
    for el in com_bbox:
        assert el.bbox.x1 <= el.bbox.x2
        assert el.bbox.y1 <= el.bbox.y2
    # IDs únicos preservando a ordem.
    ids = [el.id for el in elementos]
    assert len(ids) == len(set(ids))


def test_pdf_com_tabela(parser, sample_table_pdf: Path) -> None:
    response = parser.parse(str(sample_table_pdf), "doc-tabela", size_bytes=1)
    assert response.status == "completed"

    tabelas = [
        el
        for page in response.pages
        for el in page.elements
        if el.type == "table" and el.table is not None
    ]
    assert tabelas, "esperava ao menos uma tabela detectada"
    tabela = tabelas[0].table
    assert tabela is not None
    assert tabela.headers == ["Item", "Qtd", "Valor"]
    assert ["Energia", "10", "100,00"] in tabela.rows
    assert ["Agua", "5", "50,00"] in tabela.rows
    assert tabela.cells
    # Markdown de tabela presente.
    assert "|" in response.content.get("markdown", "")


def test_contrato_serializavel(parser, sample_text_pdf: Path) -> None:
    response = parser.parse(str(sample_text_pdf), "doc-contrato", size_bytes=1)
    dados = response.model_dump(mode="json", by_alias=True)

    assert dados["status"] == "completed"
    assert set(dados["document"]).issuperset(
        {"mimeType", "pageCount", "sizeBytes"}
    )
    assert "text" in dados["content"]
    assert "markdown" in dados["content"]
    assert dados["metadata"]["contractVersion"] == CONTRACT_VERSION
    assert isinstance(dados["pages"], list)
    assert dados["pages"][0]["pageNumber"] == 1
    assert dados["pages"][0]["elements"][0]["id"]


def test_duas_inferencias_concorrentes_nao_quebram(parser, sample_text_pdf: Path) -> None:
    """A inferência é serializada por lock; duas chamadas concorrentes não
    podem causar segfault (comportamento observado sem o lock)."""
    from concurrent.futures import ThreadPoolExecutor

    def run(index: int):
        return parser.parse(str(sample_text_pdf), f"conc-{index}", size_bytes=1)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, [1, 2]))

    assert [result.status for result in results] == ["completed", "completed"]
    assert [result.document.page_count for result in results] == [2, 2]
