"""Gera PDFs de fixture determinísticos (sem dependências externas).

Uso: python generate_fixtures.py
"""

from __future__ import annotations

import os


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(pages: list[list[str]]) -> bytes:
    """Constrói um PDF 1.4 multi-página com texto Helvetica."""
    objs: dict[int, bytes] = {}
    n_pages = len(pages)
    page_ids: list[int] = []
    content_ids: list[int] = []
    next_id = 4
    for _ in range(n_pages):
        page_ids.append(next_id)
        next_id += 1
        content_ids.append(next_id)
        next_id += 1

    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    for i, lines in enumerate(pages):
        pid, cid = page_ids[i], content_ids[i]
        objs[pid] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {cid} 0 R >>"
        ).encode()
        stream = "BT /F1 12 Tf 72 720 Td 16 TL\n"
        for line in lines:
            stream += f"({_escape(line)}) Tj T*\n"
        stream += "ET"
        data = stream.encode("latin-1")
        objs[cid] = (
            f"<< /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"
        )

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
        f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)


def build_table_pdf() -> bytes:
    """Constrói um PDF de uma página com um grid simples (tabela visual)."""
    # Desenha uma tabela 2x3 com linhas e texto, para o detector de layout.
    y_top, y_bottom = 600, 500
    x_left, x_right = 100, 400
    rows = 3
    cols = 3
    cmds = []
    # linhas horizontais
    for r in range(rows + 1):
        y = y_top - (y_top - y_bottom) * r / rows
        cmds.append(f"{x_left} {y:.2f} m {x_right} {y:.2f} l S")
    # linhas verticais
    for c in range(cols + 1):
        x = x_left + (x_right - x_left) * c / cols
        cmds.append(f"{x:.2f} {y_top} m {x:.2f} {y_bottom} l S")
    # texto das células
    cmds.append("BT /F1 10 Tf")
    cells = [
        ["Item", "Qtd", "Valor"],
        ["Energia", "10", "100,00"],
        ["Agua", "5", "50,00"],
    ]
    for r, row in enumerate(cells):
        y = y_top - (y_top - y_bottom) * (r + 0.6) / rows
        for c, value in enumerate(row):
            x = x_left + (x_right - x_left) * (c + 0.1) / cols
            cmds.append(f"1 0 0 1 {x:.2f} {y:.2f} Tm ({_escape(value)}) Tj")
    cmds.append("ET")
    content = "\n".join(cmds).encode("latin-1")
    return _assemble_single_page(content)


def _assemble_single_page(content: bytes) -> bytes:
    objs = {
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
    for oid in sorted(objs):
        offsets[oid] = len(out)
        out += f"{oid} 0 obj\n".encode() + objs[oid] + b"\nendobj\n"
    xref_pos = len(out)
    max_id = max(objs)
    out += f"xref\n0 {max_id + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for oid in range(1, max_id + 1):
        out += f"{offsets[oid]:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    sample = build_pdf(
        [
            [
                "CONTRATO DE PRESTACAO DE SERVICOS",
                "Empresa Exemplo Ltda - CNPJ 00.000.000/0001-00",
                "Este documento e um fixture sintetico de teste, sem dados reais.",
            ],
            [
                "SEGUNDA PAGINA",
                "O texto desta pagina valida a preservacao de ordem e numero de pagina.",
                "Fim do documento de teste.",
            ],
        ]
    )
    with open(os.path.join(here, "sample_text.pdf"), "wb") as f:
        f.write(sample)

    with open(os.path.join(here, "sample_table.pdf"), "wb") as f:
        f.write(build_table_pdf())

    print("fixtures geradas em", here)


if __name__ == "__main__":
    main()
