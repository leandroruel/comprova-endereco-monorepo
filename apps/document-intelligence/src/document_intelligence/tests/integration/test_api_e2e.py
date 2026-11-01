"""Teste end-to-end do endpoint HTTP com um PDF real (exige Marker)."""

from __future__ import annotations

from pathlib import Path

import pytest

from document_intelligence.tests.conftest import requires_marker

pytestmark = [pytest.mark.integration, requires_marker]


def test_parse_endpoint_pdf_real(client, sample_text_pdf: Path) -> None:
    with open(sample_text_pdf, "rb") as f:
        conteudo = f.read()

    response = client.post(
        "/documents/parse",
        files={"file": ("sample_text.pdf", conteudo, "application/pdf")},
        data={"document_id": "e2e-123"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["documentId"] == "e2e-123"
    assert body["status"] == "completed"
    assert body["document"]["pageCount"] == 2
    assert body["document"]["sizeBytes"] == len(conteudo)
    assert "text" in body["content"]
    assert body["pages"][0]["pageNumber"] == 1
    assert body["metadata"]["processor"] == "marker"
