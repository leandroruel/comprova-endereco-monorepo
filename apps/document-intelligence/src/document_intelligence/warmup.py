"""PDF sintético mínimo usado para "aquecer" o pipeline de OCR (Tesseract).

O primeiro processamento de um documento pode carregar recursos adicionais
do Tesseract e levar mais tempo em CPU. Este módulo gera um PDF de uma
pagina contendo uma imagem raster com texto, sem camada textual, para que
o caminho de OCR seja exercido no startup e nao na primeira requisicao.
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont


def build_warmup_pdf() -> bytes:
    """Retorna um PDF 1.4 de uma pagina com imagem raster e texto OCR-legivel.

    A pagina nao possui camada textual (o texto esta apenas na imagem),
    forçando o pipeline a usar OCR via Tesseract. Isso garante que o
    warmup exercite o caminho real de OCR e nao apenas a extracao de
    camada textual.
    """
    img = Image.new("RGB", (800, 1100), "white")
    draw = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36
        )
    except OSError:
        font = ImageFont.load_default()

    draw.text((80, 400), "COMPROVANTE DE RESIDENCIA", fill="black", font=font)
    draw.text((80, 460), "Titular: Usuario Teste", fill="black", font=font)
    draw.text((80, 520), "Endereco: RUA X, 100", fill="black", font=font)

    buffer = io.BytesIO()
    img.save(buffer, format="PDF", resolution=200.0)
    return buffer.getvalue()
