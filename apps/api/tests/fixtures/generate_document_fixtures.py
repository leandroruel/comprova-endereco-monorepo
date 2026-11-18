"""Gera PDFs de fixture realistas para testar o pipeline de documentos.

PDFs sintéticos, sem dados pessoais reais. Usados para validar a integração
com o Marker real (PDF textual, digitalizado, múltiplas páginas, layout
complexo).
"""

from __future__ import annotations

import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(pages: list[list[str]]) -> bytes:
    """Constrói um PDF 1.4 multi-página com texto Helvetica (camada de texto)."""
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


def build_image_pdf_from_png(png_bytes: bytes) -> bytes:
    """PDF de uma página com uma imagem raster PNG embutida (sem camada de texto).

    Simula um documento digitalizado/foto: o Marker precisa fazer OCR.

    A imagem PNG recebida é incorporada diretamente ao PDF, preservando seu
    conteúdo visual para que o OCR consiga extrair o texto.
    """
    from io import BytesIO

    from PIL import Image

    # Abre a imagem PNG recebida e salva como PDF de uma página, incorporando
    # os pixels originais. Isso garante que o texto desenhado na imagem esteja
    # disponível para o OCR do Marker.
    img = Image.open(BytesIO(png_bytes))
    # Converte para RGB se necessário (PDF não suporta todos os modos).
    if img.mode != "RGB":
        img = img.convert("RGB")

    buf = BytesIO()
    img.save(buf, format="PDF", resolution=150.0)
    pdf_bytes = buf.getvalue()

    # Validação: o PDF deve ser um PDF válido e conter a imagem incorporada.
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("PDF gerado não tem cabeçalho PDF válido")
    if len(pdf_bytes) < 1000:
        raise ValueError("PDF gerado está muito pequeno para conter a imagem")

    return pdf_bytes


def conta_energia_pdf() -> bytes:
    """Comprovante de energia elétrica (texto, uma página)."""
    return build_pdf(
        [
            [
                "CONTA DE ENERGIA ELETRICA",
                "Empresa Exemplo Energia S.A. - CNPJ 00.000.000/0001-00",
                "Titular: Maria da Silva",
                "CPF: 123.456.789-00",
                "Endereco: Rua das Flores, 123, Apto 45",
                "Bairro: Centro",
                "Cidade: Sao Paulo",
                "UF: SP",
                "CEP: 01001-000",
                "Vencimento: 10/11/2026",
                "Valor: R$ 150,00",
                "Competencia: 10/2026",
            ]
        ]
    )


def conta_agua_pdf() -> bytes:
    """Comprovante de água (texto, uma página)."""
    return build_pdf(
        [
            [
                "CONTA DE AGUA",
                "SABESP - Companhia de Saneamento",
                "Titular: Joao Pereira Santos",
                "Endereco: Avenida Paulista, 1000",
                "Bairro: Bela Vista",
                "Cidade: Sao Paulo",
                "UF: SP",
                "CEP: 01310-100",
                "Vencimento: 05/11/2026",
                "Valor: R$ 89,50",
                "Competencia: 10/2026",
            ]
        ]
    )


def conta_telefone_pdf() -> bytes:
    """Comprovante de telefone (texto, uma página)."""
    return build_pdf(
        [
            [
                "CONTA DE TELEFONE",
                "Vivo Telefonia S.A.",
                "Titular: Ana Costa Oliveira",
                "Endereco: Rua Oscar Freire, 500",
                "Bairro: Jardins",
                "Cidade: Sao Paulo",
                "UF: SP",
                "CEP: 01425-000",
                "Vencimento: 15/11/2026",
                "Valor: R$ 120,00",
                "Competencia: 10/2026",
            ]
        ]
    )


def conta_divergente_pdf() -> bytes:
    """Comprovante com endereço divergente do claim."""
    return build_pdf(
        [
            [
                "CONTA DE ENERGIA ELETRICA",
                "Empresa Exemplo Energia S.A.",
                "Titular: Maria da Silva",
                "Endereco: Rua das Acacias, 999, Casa 2",
                "Bairro: Jardim Europa",
                "Cidade: Sao Paulo",
                "UF: SP",
                "CEP: 01451-000",
                "Vencimento: 10/11/2026",
                "Valor: R$ 200,00",
            ]
        ]
    )


def pdf_sem_endereco_pdf() -> bytes:
    """Comprovante sem endereço identificável."""
    return build_pdf(
        [
            [
                "CONTA DE ENERGIA ELETRICA",
                "Empresa Exemplo Energia S.A.",
                "Titular: Carlos Souza",
                "Vencimento: 10/11/2026",
                "Valor: R$ 150,00",
            ]
        ]
    )


def pdf_digitalizado(png_bytes: bytes) -> bytes:
    """PDF digitalizado (imagem raster sem camada de texto)."""
    return build_image_pdf_from_png(png_bytes)


def multipagina_pdf() -> bytes:
    """PDF com múltiplas páginas (conta de energia + segunda página)."""
    return build_pdf(
        [
            [
                "CONTA DE ENERGIA ELETRICA",
                "Empresa Exemplo Energia S.A.",
                "Titular: Maria da Silva",
                "Endereco: Rua das Flores, 123, Apto 45",
                "CEP: 01001-000",
                "Vencimento: 10/11/2026",
            ],
            [
                "PAGINA 2 - DETALHES DE CONSUMO",
                "Leitura anterior: 12345 kWh",
                "Leitura atual: 12500 kWh",
                "Consumo: 155 kWh",
                "Valor da energia: R$ 140,00",
            ],
        ]
    )


def main() -> None:
    from PIL import Image, ImageDraw, ImageFont

    # Gera uma imagem PNG simulando um documento digitalizado (conta de energia).
    img = Image.new("RGB", (612, 792), "white")
    draw = ImageDraw.Draw(img)

    linhas = [
        "CONTA DE ENERGIA ELETRICA",
        "Empresa Exemplo Energia S.A.",
        "Titular: Maria da Silva",
        "Endereco: Rua das Flores, 123, Apto 45",
        "Bairro: Centro",
        "Cidade: Sao Paulo",
        "UF: SP",
        "CEP: 01001-000",
        "Vencimento: 10/11/2026",
        "Valor: R$ 150,00",
    ]
    y = 100
    for linha in linhas:
        draw.text((60, y), linha, fill="black")
        y += 40

    buffer = []
    img.save(os.path.join(HERE, "conta_energia_digitalizado.png"), format="PNG")
    png_bytes = None
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    fixtures = {
        "conta_energia.pdf": conta_energia_pdf(),
        "conta_agua.pdf": conta_agua_pdf(),
        "conta_telefone.pdf": conta_telefone_pdf(),
        "conta_divergente.pdf": conta_divergente_pdf(),
        "sem_endereco.pdf": pdf_sem_endereco_pdf(),
        "digitalizado.pdf": pdf_digitalizado(png_bytes),
        "multipagina.pdf": multipagina_pdf(),
    }

    for nome, dados in fixtures.items():
        caminho = os.path.join(HERE, nome)
        with open(caminho, "wb") as f:
            f.write(dados)
        print(f"gerado {caminho} ({len(dados)} bytes)")

    print("fixtures gerados em", HERE)


if __name__ == "__main__":
    main()
