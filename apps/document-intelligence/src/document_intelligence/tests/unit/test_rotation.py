"""Testes de páginas rotacionadas: dimensões e coordenadas."""

from __future__ import annotations

import pypdfium2 as pdfium
import pytest

from document_intelligence.pdf_processor import _page_size_points


def _build_rotated_pdf(rotation: int) -> bytes:
    """Constrói um PDF de 1 página com o /Rotate especificado."""
    content = b"BT /F1 12 Tf 72 720 Td (Teste) Tj ET"
    content_len = len(content)

    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            + f"/Rotate {rotation} ".encode()
            + b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        5: f"<< /Length {content_len} >>\nstream\n".encode()
        + content
        + b"\nendstream",
    }

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for oid in sorted(objs):
        offsets[oid] = len(out)
        out += f"{oid} 0 obj\n".encode() + objs[oid] + b"\nendobj\n"

    xref_pos = len(out)
    max_id = max(objs)
    out += f"xref\n0 {max_id + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for oid in range(1, max_id + 1):
        if oid in offsets:
            out += f"{offsets[oid]:010d} 00000 n \n".encode()
        else:
            out += b"0000000000 65535 f \n"
    out += (
        b"trailer\n<< /Size " + str(max_id + 1).encode() + b" /Root 1 0 R >>\n"
        + f"startxref\n{xref_pos}\n%%EOF\n".encode()
    )
    return bytes(out)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_page_size_points_respeita_rotacao(rotation: int, tmp_path) -> None:
    """Dimensões devem considerar a rotação da página."""
    pdf_path = tmp_path / f"rotacionado_{rotation}.pdf"
    pdf_path.write_bytes(_build_rotated_pdf(rotation))

    document = pdfium.PdfDocument(str(pdf_path))
    try:
        width, height = _page_size_points(document, 0)
        page = document[0]
        assert page.get_rotation() == rotation

        if rotation in (0, 180):
            # Sem rotação ou 180°: largura = 612, altura = 792
            assert width == 612.0
            assert height == 792.0
        else:
            # 90° ou 270°: largura e altura são trocadas
            assert width == 792.0
            assert height == 612.0
    finally:
        document.close()


@pytest.mark.parametrize("dpi", [200, 300, 400])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_coordenadas_dentro_dos_limites_apos_rotacao(
    rotation: int, dpi: int, tmp_path
) -> None:
    """Bounding boxes devem ficar dentro dos limites da página após rotação."""
    from document_intelligence.ocr import OcrWord, _words_to_lines

    pdf_path = tmp_path / f"rot_{rotation}_dpi_{dpi}.pdf"
    pdf_path.write_bytes(_build_rotated_pdf(rotation))

    document = pdfium.PdfDocument(str(pdf_path))
    try:
        width_pts, height_pts = _page_size_points(document, 0)

        # Simula palavras do OCR com coordenadas em pixels.
        # Para DPI 200: escala = 72/200 = 0.36
        # Um objeto em (100, 100, 50, 20) px deve resultar em:
        # x1 = 100 * 0.36 = 36.0, x2 = 150 * 0.36 = 54.0
        scale = 72.0 / dpi
        words_px = [
            OcrWord(
                text="teste",
                left=int(100 * dpi / 200),  # Ajusta para o DPI atual
                top=int(100 * dpi / 200),
                width=int(50 * dpi / 200),
                height=int(20 * dpi / 200),
                confidence=90,
                block_num=1,
                par_num=1,
                line_num=1,
                word_num=1,
            )
        ]

        # page_height_px para conversão de y (origem baixo-esquerda no PDF)
        page_height_px = int(height_pts * dpi / 72)
        page_width_px = int(width_pts * dpi / 72)

        lines = _words_to_lines(
            words_px, page_width_px, page_height_px, dpi=dpi
        )

        assert len(lines) == 1
        line = lines[0]

        # Coordenadas devem estar dentro dos limites da página (em pontos)
        assert 0 <= line.x1 <= width_pts
        assert 0 <= line.x2 <= width_pts
        assert 0 <= line.y1 <= height_pts
        assert 0 <= line.y2 <= height_pts

        # Para páginas rotacionadas 90/270, largura e altura são trocadas.
        if rotation in (0, 180):
            assert width_pts == 612.0
            assert height_pts == 792.0
        else:
            assert width_pts == 792.0
            assert height_pts == 612.0
    finally:
        document.close()
