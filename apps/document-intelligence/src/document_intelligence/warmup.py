"""PDF sintético mínimo usado para "aquecer" os modelos do Marker.

O primeiro documento que exercita o caminho de layout/OCR de tabelas carrega
pesos adicionais (rf-detr / reconhecimento) e pode levar minutos em CPU. Este
módulo gera um PDF de uma página com um grid simples, sem dados reais, para que
esse custo aconteça no startup e não na primeira requisição.
"""

from __future__ import annotations


def _escape(text: str) -> str:
    """Escapa caracteres reservados de strings literais em conteúdo PDF."""
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_warmup_pdf() -> bytes:
    """Retorna um PDF 1.4 de uma página com texto e uma tabela 2x3."""
    y_top, y_bottom = 600, 500
    x_left, x_right = 100, 400
    rows, cols = 3, 3
    cmds: list[str] = []

    for r in range(rows + 1):
        y = y_top - (y_top - y_bottom) * r / rows
        cmds.append(f"{x_left} {y:.2f} m {x_right} {y:.2f} l S")
    for c in range(cols + 1):
        x = x_left + (x_right - x_left) * c / cols
        cmds.append(f"{x:.2f} {y_top} m {x:.2f} {y_bottom} l S")

    cmds.append("BT /F1 10 Tf")
    cells = [["A", "B", "C"], ["1", "2", "3"], ["4", "5", "6"]]
    for r, row in enumerate(cells):
        y = y_top - (y_top - y_bottom) * (r + 0.6) / rows
        for c, value in enumerate(row):
            x = x_left + (x_right - x_left) * (c + 0.1) / cols
            cmds.append(f"1 0 0 1 {x:.2f} {y:.2f} Tm ({_escape(value)}) Tj")
    cmds.append("ET")
    content = "\n".join(cmds).encode("latin-1")

    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        5: f"<< /Length {len(content)} >>\nstream\n".encode()
        + content
        + b"\nendstream",
    }

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for oid in sorted(objects):
        offsets[oid] = len(out)
        out += f"{oid} 0 obj\n".encode() + objects[oid] + b"\nendobj\n"

    xref_pos = len(out)
    max_id = max(objects)
    out += f"xref\n0 {max_id + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for oid in range(1, max_id + 1):
        out += f"{offsets[oid]:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)
