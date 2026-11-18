"""Gerador de documentos sintéticos de comprovante de residência.

Produz PDFs fictícios (digitar e escaneados) de contas de energia e água,
com variações de layout, cabeçalho, tipografia, alinhamento, tabela, contraste,
resolução, inclinação, qualidade de impressão e casos de dificuldade realista.

Uso:
    python generate_fixtures.py

Não produz documentos reais nem dados pessoais reais. Todos os documentos
contêm a marca d'água: "DOCUMENTO FICTÍCIO - TESTE".
"""

from __future__ import annotations

import io
import os
import random
from dataclasses import dataclass
from typing import Callable

from PIL import Image, ImageDraw, ImageFont, ImageOps

# ---------------------------------------------------------------------------
# Configuração geral
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.abspath(__file__))

WIDTH_PT, HEIGHT_PT = 612, 792  # Carta (Letter)
MARGIN = 54  # ~0,75 pol.

SEED = 20260518
random.seed(SEED)

# Fontes disponíveis no ambiente (fallback para DejaVu se houver).
FONTS_REGULAR = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
FONTS_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def _first_existing(paths: list[str], fallback: str = "DejaVuSans") -> str:
    for p in paths:
        if os.path.exists(p):
            return p
    return fallback


FONT_REG = _first_existing(FONTS_REGULAR)
FONT_BOLD = _first_existing(FONTS_BOLD)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if bold else FONT_REG
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    text: str,
    fnt: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int] = (0, 0, 0),
    anchor: str = "la",
) -> None:
    draw.text(xy, text, font=fnt, fill=fill, anchor=anchor)


def draw_centered(
    draw: ImageDraw.ImageDraw,
    cx: float,
    y: float,
    text: str,
    fnt: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int] = (0, 0, 0),
) -> None:
    draw.text((cx, y), text, font=fnt, fill=fill, anchor="mm")


def draw_rect(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    outline: tuple[int, int, int] | None = None,
    width: int = 1,
    fill: tuple[int, int, int] | None = None,
) -> None:
    if fill is not None:
        draw.rectangle(box, fill=fill)
    if outline is not None:
        draw.rectangle(box, outline=outline, width=width)


def draw_line(
    draw: ImageDraw.ImageDraw,
    p1: tuple[float, float],
    p2: tuple[float, float],
    fill: tuple[int, int, int] = (0, 0, 0),
    width: int = 1,
) -> None:
    draw.line([p1, p2], fill=fill, width=width)


def new_canvas(
    width: int = WIDTH_PT, height: int = HEIGHT_PT, bg: tuple[int, int, int] = (255, 255, 255)
) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (width, height), bg)
    return img, ImageDraw.Draw(img)


def save_pdf(img: Image.Image, path: str, dpi: int = 150) -> None:
    """Salva uma imagem como PDF de 1 página (camada raster, escaneado)."""
    img.convert("RGB").save(path, "PDF", resolution=dpi)


def save_png(img: Image.Image, path: str) -> None:
    img.convert("RGB").save(path, "PNG")


def watermark(draw: ImageDraw.ImageDraw, w: int, h: int) -> None:
    """Marca d'água visível: DOCUMENTO FICTÍCIO - TESTE."""
    fnt = font(22, bold=True)
    text = "DOCUMENTO FICTÍCIO - TESTE"
    # Desenha repetida diagonalmente para dificultar remoção simples.
    step = 220
    for dy in range(-h, h, step):
        for dx in range(-w, w, step):
            draw.text(
                (dx, dy),
                text,
                font=fnt,
                fill=(170, 170, 170),
                anchor="mm",
            )


def cpf_ficticio() -> str:
    """CPF fictício (formato apenas, não é um CPF válido de pessoa real)."""
    nums = [str(random.randint(0, 9)) for _ in range(11)]
    return f"{nums[0]}{nums[1]}{nums[2]}.{nums[3]}{nums[4]}{nums[5]}.{nums[6]}{nums[7]}{nums[8]}-{nums[9]}{nums[10]}"


def cnpj_ficticio() -> str:
    """CNPJ fictício."""
    nums = [str(random.randint(0, 9)) for _ in range(14)]
    return (
        f"{nums[0]}{nums[1]}.{nums[2]}{nums[3]}{nums[4]}.{nums[5]}{nums[6]}{nums[7]}/"
        f"{nums[8]}{nums[9]}{nums[10]}{nums[11]}-{nums[12]}{nums[13]}"
    )


def cep_ficticio() -> str:
    """CEP fictício."""
    nums = [str(random.randint(0, 9)) for _ in range(8)]
    return f"{nums[0]}{nums[1]}{nums[2]}{nums[3]}{nums[4]}-{nums[5]}{nums[6]}{nums[7]}"


@dataclass
class Emitter:
    """Emissor demonstrativo de documento."""

    tipo: str  # "energia" | "agua"
    nome: str
    uf: str
    cidade: str
    cnpj: str
    codigo_cliente_prefixo: str
    layout_version: str


def emissores() -> list[Emitter]:
    """Catálogo de emissores demonstrativos (não são concessionárias reais)."""
    return [
        Emitter("energia", "Distribuidora Energia Demo SP", "SP", "São Paulo", "11.222.333/0001-44", "DESP", "v1.2"),
        Emitter("energia", "Distribuidora Energia Demo RJ", "RJ", "Rio de Janeiro", "22.333.444/0001-55", "DERJ", "v1.1"),
        Emitter("energia", "Distribuidora Energia Demo MG", "MG", "Belo Horizonte", "33.444.555/0001-66", "DEMG", "v1.3"),
        Emitter("agua", "Companhia de Água Demo SP", "SP", "São Paulo", "44.555.666/0001-77", "CADSP", "v1.0"),
        Emitter("agua", "Companhia de Água Demo RJ", "RJ", "Rio de Janeiro", "55.666.777/0001-88", "CADRJ", "v1.2"),
        Emitter("agua", "Serviço Municipal de Saneamento Demo MG", "MG", "Belo Horizonte", "66.777.888/0001-99", "SMSDMG", "v1.1"),
        Emitter("agua", "Companhia de Água Demo ES", "ES", "Vitória", "77.888.999/0001-00", "CADES", "v1.0"),
    ]


@dataclass
class Holder:
    """Titular fictício da conta."""

    nome: str
    cpf: str
    endereco: str
    cep: str
    cidade: str
    uf: str
    instalacao: str
    codigo_cliente: str


def titular(emissor: Emitter, rng: random.Random) -> Holder:
    """Gera um titular fictício."""
    nomes = [
        "Ana Pereira Silva",
        "Carlos Eduardo Mendes",
        "Fernanda Oliveira Costa",
        "Ricardo Alves Souza",
        "Juliana Beatriz Lima",
        "Marcos Vinícius Rocha",
        "Patrícia Gomes Dias",
        "André Luiz Ferreira",
        "Camila Santos Moreira",
        "Luiz Henrique Nunes",
    ]
    enderecos = [
        "Rua das Flores, 123, Apto 101",
        "Av. Paulista, 1500, conj. 12",
        "Rua Augusta, 890",
        "Alameda Santos, 450, sala 8",
        "Rua Consolação, 2040",
        "Av. Atlântica, 3000, apto 502",
        "Rua Oscar Freire, 500",
        "Av. das Nações Unidas, 12000",
        "Rua Haddock Lobo, 300",
        "Av. Brigadeiro Luís Antônio, 900",
    ]
    cidades = {
        "SP": ["São Paulo", "Guarulhos", "Campinas", "São Bernardo do Campo"],
        "RJ": ["Rio de Janeiro", "Niterói", "Duque de Caxias", "Nova Iguaçu"],
        "MG": ["Belo Horizonte", "Uberlândia", "Contagem", "Juiz de Fora"],
        "ES": ["Vitória", "Vila Velha", "Serra", "Cariacica"],
    }
    nome = rng.choice(nomes)
    endereco = rng.choice(enderecos)
    cidade = rng.choice(cidades.get(emissor.uf, [emissor.cidade]))
    cep = cep_ficticio()
    instalacao = f"{rng.randint(100000,999999)}-{rng.randint(10,99)}"
    codigo_cliente = f"{emissor.codigo_cliente_prefixo}-{rng.randint(1000000,9999999)}"
    return Holder(
        nome=nome,
        cpf=cpf_ficticio(),
        endereco=endereco,
        cep=cep,
        cidade=cidade,
        uf=emissor.uf,
        instalacao=instalacao,
        codigo_cliente=codigo_cliente,
    )


# ---------------------------------------------------------------------------
# Consumo e datas (compartilhado)
# ---------------------------------------------------------------------------

def consumo_energia(rng: random.Random) -> dict:
    return {
        "leitura_anterior": str(rng.randint(100, 900)),
        "leitura_atual": str(rng.randint(901, 2000)),
        "consumo_kwh": str(rng.randint(120, 650)),
        "tarifa": "R$ 0,7842 / kWh",
        "valor_energia": f"R$ {rng.randint(80, 400)},{rng.randint(0,99):02d}",
    }


def consumo_agua(rng: random.Random) -> dict:
    return {
        "leitura_anterior": str(rng.randint(50, 400)),
        "leitura_atual": str(rng.randint(401, 900)),
        "consumo_m3": str(rng.randint(10, 120)),
        "tarifa": "R$ 4,35 / m³",
        "valor_agua": f"R$ {rng.randint(40, 300)},{rng.randint(0,99):02d}",
    }


def datas(rng: random.Random) -> dict:
    mes = rng.randint(1, 12)
    ano = 2025
    dia_emissao = rng.randint(1, 28)
    dia_vencimento = min(dia_emissao + 10, 28)
    return {
        "emissao": f"{dia_emissao:02d}/{mes:02d}/{ano}",
        "vencimento": f"{dia_vencimento:02d}/{mes:02d}/{ano}",
        "referencia": f"{mes:02d}/{ano}",
    }


# ===========================================================================
# Layouts de ENERGIA
# ===========================================================================

def layout_energia_cabecalho_topo(img: Image.Image, draw: ImageDraw.ImageDraw, w: int, h: int,
                                  emissor: Emitter, holder: Holder, cons: dict, dat: dict,
                                  rng: random.Random) -> None:
    """Layout A: cabeçalho centralizado em cima, dados do titular à esquerda,
    resumo financeiro à direita, tabela de consumo central."""
    fnt_titulo = font(26, bold=True)
    fnt_sub = font(13)
    fnt_dado = font(16)
    fnt_pequeno = font(12)

    # Cabeçalho centralizado.
    draw_centered(draw, w / 2, 70, emissor.nome, fnt_titulo)
    draw_centered(draw, w / 2, 102, "CONTA DE ENERGIA ELÉTRICA", fnt_sub)
    draw_centered(draw, w / 2, 124, f"CNPJ {emissor.cnpj}  |  {emissor.cidade}/{emissor.uf}", fnt_pequeno)
    draw_line(draw, (MARGIN, 148), (w - MARGIN, 148), width=2)

    # Dados do titular (esquerda).
    yy = 170
    draw_text(draw, (MARGIN, yy), "Titular:", fnt_dado, fill=(60, 60, 60)); yy += 26
    draw_text(draw, (MARGIN, yy), holder.nome, fnt_dado); yy += 26
    draw_text(draw, (MARGIN, yy), f"CPF: {holder.cpf}", fnt_dado); yy += 26
    draw_text(draw, (MARGIN, yy), f"Endereço: {holder.endereco}", fnt_dado); yy += 26
    draw_text(draw, (MARGIN, yy), f"{holder.cidade}/{holder.uf}  CEP {holder.cep}", fnt_dado); yy += 36

    # Resumo financeiro (direita).
    rx = w - MARGIN - 230
    draw_text(draw, (rx, 170), "RESUMO DA FATURA", fnt_sub, fill=(60, 60, 60)); yy_r = 196
    draw_text(draw, (rx, yy_r), f"Valor total: R$ {rng.randint(100, 500)},{rng.randint(0,99):02d}", fnt_dado); yy_r += 30
    draw_text(draw, (rx, yy_r), f"Vencimento: {dat['vencimento']}", fnt_dado); yy_r += 30
    draw_text(draw, (rx, yy_r), f"Emissão: {dat['emissao']}", fnt_dado); yy_r += 30
    draw_text(draw, (rx, yy_r), f"Ref: {dat['referencia']}", fnt_dado); yy_r += 36

    # Tabela de consumo (central).
    ty = 340
    draw_text(draw, (MARGIN, ty), "DETALHE DO CONSUMO", fnt_sub, fill=(60, 60, 60)); ty += 24
    col_x = [MARGIN, MARGIN + 170, MARGIN + 300, MARGIN + 430]
    headers = ["Leitura anterior", "Leitura atual", "Consumo (kWh)", "Valor (R$)"]
    for cx, htxt in zip(col_x, headers):
        draw_text(draw, (cx, ty), htxt, font(13, bold=True), fill=(60, 60, 60))
    ty += 24
    draw_line(draw, (MARGIN, ty), (col_x[-1] + 120, ty), width=1)
    ty += 26
    vals = [cons["leitura_anterior"], cons["leitura_atual"], cons["consumo_kwh"], cons["valor_energia"].split(" ")[1]]
    for cx, v in zip(col_x, vals):
        draw_text(draw, (cx, ty), v, font(14))
    ty += 34
    draw_text(draw, (MARGIN, ty), f"Instalação: {holder.instalacao}", fnt_dado)
    draw_text(draw, (MARGIN, ty + 24), f"Código do cliente: {holder.codigo_cliente}", fnt_dado)
    draw_text(draw, (MARGIN, ty + 48), f"Data de emissão: {dat['emissao']}", fnt_pequeno)

    # Rodapé.
    draw_line(draw, (MARGIN, h - 60), (w - MARGIN, h - 60), width=1)
    draw_centered(draw, w / 2, h - 42, "DOCUMENTO FICTÍCIO - TESTE", font(11), fill=(150, 150, 150))


def layout_energia_coluna_esquerda(img: Image.Image, draw: ImageDraw.ImageDraw, w: int, h: int,
                                   emissor: Emitter, holder: Holder, cons: dict, dat: dict,
                                   rng: random.Random) -> None:
    """Layout B: coluna esquerda com identidade do emissor, corpo com duas
    colunas (dados à esquerda, consumo à direita), alinhamento à esquerda."""
    fnt_titulo = font(22, bold=True)
    fnt_sub = font(12)
    fnt_dado = font(15)
    fnt_pequeno = font(11)

    # Barra lateral esquerda com identidade.
    draw_rect(draw, (0, 0, 150, h), fill=(235, 240, 245))
    draw_text(draw, (20, 60), emissor.nome, fnt_titulo)
    draw_text(draw, (20, 90), "CONTA DE ENERGIA", font(13, bold=True))
    draw_text(draw, (20, 112), f"CNPJ {emissor.cnpj}", fnt_pequeno)
    draw_text(draw, (20, 130), f"{emissor.cidade}/{emissor.uf}", fnt_pequeno)
    draw_text(draw, (20, 150), "Versão layout: " + emissor.layout_version, fnt_pequeno)

    yy = 190
    # Dados do titular.
    draw_text(draw, (180, yy), "DADOS DO CONTRATO", font(14, bold=True)); yy += 24
    draw_text(draw, (180, yy), f"Titular: {holder.nome}", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"CPF: {holder.cpf}", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"Endereço: {holder.endereco}", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"{holder.cidade}/{holder.uf} - CEP {holder.cep}", fnt_dado); yy += 34

    # Consumo e valores.
    draw_text(draw, (180, yy), "CONSUMO DO PERÍODO", font(14, bold=True)); yy += 24
    draw_text(draw, (180, yy), f"Leitura anterior: {cons['leitura_anterior']} kWh", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"Leitura atual: {cons['leitura_atual']} kWh", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"Consumo: {cons['consumo_kwh']} kWh", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"Tarifa: {cons['tarifa']}", fnt_dado); yy += 24
    draw_text(draw, (180, yy), f"Valor da energia: {cons['valor_energia']}", fnt_dado); yy += 34

    # Coluna direita com datas e código cliente.
    rx = 380
    draw_text(draw, (rx, 190), "PAGAMENTO", font(14, bold=True))
    draw_text(draw, (rx, 214), f"Vencimento: {dat['vencimento']}", fnt_dado)
    draw_text(draw, (rx, 238), f"Emissão: {dat['emissao']}", fnt_dado)
    draw_text(draw, (rx, 262), f"Referência: {dat['referencia']}", fnt_dado)
    draw_text(draw, (rx, 286), f"Instalação: {holder.instalacao}", fnt_dado)
    draw_text(draw, (rx, 310), f"Código do cliente: {holder.codigo_cliente}", fnt_dado)

    # Rodapé com linha fina.
    draw_line(draw, (180, h - 60), (w - MARGIN, h - 60), width=1)
    draw_text(draw, (180, h - 42), "DOCUMENTO FICTÍCIO - TESTE", font(11), fill=(150, 150, 150))


def layout_energia_tabela_simples(img: Image.Image, draw: ImageDraw.ImageDraw, w: int, h: int,
                                  emissor: Emitter, holder: Holder, cons: dict, dat: dict,
                                  rng: random.Random) -> None:
    """Layout C: visual tipo tabela larga, cabeçalho à esquerda, bloco de
    valores destacado com borda, tipografia variada."""
    fnt_titulo = font(24, bold=True)
    fnt_sub = font(13)
    fnt_dado = font(16)
    fnt_pequeno = font(11)

    # Cabeçalho à esquerda.
    draw_text(draw, (MARGIN, 60), emissor.nome, fnt_titulo)
    draw_text(draw, (MARGIN, 92), "FATURA DE ENERGIA ELÉTRICA", font(14, bold=True))
    draw_text(draw, (MARGIN, 114), f"CNPJ {emissor.cnpj}", fnt_pequeno)
    draw_text(draw, (MARGIN, 132), f"{emissor.cidade}/{emissor.uf}", fnt_pequeno)
    draw_line(draw, (MARGIN, 152), (w - MARGIN, 152), width=2)

    # Bloco de dados do titular com borda.
    box_top = 170
    draw_rect(draw, (MARGIN, box_top, w - MARGIN, box_top + 110), outline=(100, 100, 100), width=1)
    yy = box_top + 16
    draw_text(draw, (MARGIN + 12, yy), "CLIENTE", font(12, bold=True), fill=(80, 80, 80)); yy += 20
    draw_text(draw, (MARGIN + 12, yy), f"Nome: {holder.nome}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN + 12, yy), f"CPF: {holder.cpf}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN + 12, yy), f"Endereço: {holder.endereco}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN + 12, yy), f"{holder.cidade}/{holder.uf}  CEP {holder.cep}", fnt_dado)

    # Bloco de consumo destacado (destaque com fundo leve).
    box2_top = box_top + 130
    draw_rect(draw, (MARGIN, box2_top, w - MARGIN, box2_top + 90), fill=(248, 248, 248), outline=(160, 160, 160), width=1)
    yy = box2_top + 14
    draw_text(draw, (MARGIN + 12, yy), "CONSUMO E VALOR", font(12, bold=True), fill=(80, 80, 80)); yy += 20
    draw_text(draw, (MARGIN + 12, yy), f"Leitura anterior: {cons['leitura_anterior']}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN + 12, yy), f"Leitura atual: {cons['leitura_atual']}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN + 12, yy), f"Consumo: {cons['consumo_kwh']} kWh  |  {cons['valor_energia']}", fnt_dado)

    # Datas e códigos à direita abaixo.
    ry = box2_top + 110
    draw_text(draw, (MARGIN, ry), f"Emissão: {dat['emissao']}      Vencimento: {dat['vencimento']}", fnt_dado); ry += 24
    draw_text(draw, (MARGIN, ry), f"Instalação: {holder.instalacao}      Código do cliente: {holder.codigo_cliente}", fnt_dado); ry += 24
    draw_text(draw, (MARGIN, ry), f"Referência: {dat['referencia']}", fnt_pequeno)

    draw_line(draw, (MARGIN, h - 60), (w - MARGIN, h - 60), width=1)
    draw_centered(draw, w / 2, h - 42, "DOCUMENTO FICTÍCIO - TESTE", font(11), fill=(150, 150, 150))


LAYOUTS_ENERGIA = [
    layout_energia_cabecalho_topo,
    layout_energia_coluna_esquerda,
    layout_energia_tabela_simples,
]


# ===========================================================================
# Layouts de ÁGUA
# ===========================================================================

def layout_agua_bloco_conta(img: Image.Image, draw: ImageDraw.ImageDraw, w: int, h: int,
                            emissor: Emitter, holder: Holder, cons: dict, dat: dict,
                            rng: random.Random) -> None:
    """Layout A: cabeçalho com logo simulado (retângulo) à esquerda, dados do
    titular e consumo em blocos empilhados, alinhamento misto."""
    fnt_titulo = font(24, bold=True)
    fnt_sub = font(12)
    fnt_dado = font(15)
    fnt_pequeno = font(11)

    # "Logo" simulado (retângulo, não é logotipo real).
    draw_rect(draw, (MARGIN, 50, MARGIN + 70, 110), fill=(200, 220, 235), outline=(90, 130, 160), width=2)
    draw_centered(draw, MARGIN + 35, 80, "H₂O", font(18, bold=True), fill=(70, 110, 140))
    draw_text(draw, (MARGIN + 85, 62), emissor.nome, fnt_titulo)
    draw_text(draw, (MARGIN + 85, 94), "CONTA DE ÁGUA E SANEAMENTO", fnt_sub)
    draw_text(draw, (MARGIN + 85, 112), f"CNPJ {emissor.cnpj}", fnt_pequeno)
    draw_line(draw, (MARGIN, 132), (w - MARGIN, 132), width=2)

    yy = 152
    # Bloco titular.
    draw_text(draw, (MARGIN, yy), "DADOS DO TITULAR", font(12, bold=True), fill=(70, 110, 140)); yy += 22
    draw_text(draw, (MARGIN, yy), f"Nome: {holder.nome}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"CPF: {holder.cpf}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"Endereço: {holder.endereco}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"{holder.cidade}/{holder.uf} - CEP {holder.cep}", fnt_dado); yy += 34

    # Bloco consumo.
    draw_text(draw, (MARGIN, yy), "CONSUMO MENSAL", font(12, bold=True), fill=(70, 110, 140)); yy += 22
    draw_text(draw, (MARGIN, yy), f"Leitura anterior: {cons['leitura_anterior']} m³", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"Leitura atual: {cons['leitura_atual']} m³", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"Consumo: {cons['consumo_m3']} m³", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"Tarifa: {cons['tarifa']}", fnt_dado); yy += 24
    draw_text(draw, (MARGIN, yy), f"Valor da água: {cons['valor_agua']}", fnt_dado); yy += 36

    # Datas à direita.
    rx = 360
    draw_text(draw, (rx, 152), f"Vencimento: {dat['vencimento']}", fnt_dado)
    draw_text(draw, (rx, 176), f"Emissão: {dat['emissao']}", fnt_dado)
    draw_text(draw, (rx, 200), f"Referência: {dat['referencia']}", fnt_dado)
    draw_text(draw, (rx, 224), f"Matrícula: {holder.instalacao}", fnt_dado)
    draw_text(draw, (rx, 248), f"Código do cliente: {holder.codigo_cliente}", fnt_dado)

    draw_line(draw, (MARGIN, h - 60), (w - MARGIN, h - 60), width=1)
    draw_centered(draw, w / 2, h - 42, "DOCUMENTO FICTÍCIO - TESTE", font(11), fill=(150, 150, 150))


def layout_agua_dois_colunas(img: Image.Image, draw: ImageDraw.ImageDraw, w: int, h: int,
                             emissor: Emitter, holder: Holder, cons: dict, dat: dict,
                             rng: random.Random) -> None:
    """Layout B: duas colunas simétricas. Esquerda: emissor + titular. Direita:
    consumo + pagamento. Tipografia menor e mais densa."""
    fnt_titulo = font(20, bold=True)
    fnt_sub = font(11)
    fnt_dado = font(13)
    fnt_pequeno = font(10)

    # Cabeçalho.
    draw_centered(draw, w / 2, 55, emissor.nome, fnt_titulo)
    draw_centered(draw, w / 2, 82, "COMPROVANTE DE ÁGUA", font(13, bold=True))
    draw_centered(draw, w / 2, 100, f"{emissor.cidade}/{emissor.uf}  |  CNPJ {emissor.cnpj}", fnt_sub)
    draw_line(draw, (MARGIN, 118), (w - MARGIN, 118), width=2)

    col_w = (w - 3 * MARGIN) / 2
    cx1 = MARGIN
    cx2 = MARGIN + col_w + MARGIN

    # Coluna 1: titular.
    yy = 140
    draw_text(draw, (cx1, yy), "TITULAR", font(11, bold=True), fill=(90, 90, 90)); yy += 18
    draw_text(draw, (cx1, yy), holder.nome, fnt_dado); yy += 20
    draw_text(draw, (cx1, yy), f"CPF {holder.cpf}", fnt_dado); yy += 20
    draw_text(draw, (cx1, yy), holder.endereco, fnt_dado); yy += 20
    draw_text(draw, (cx1, yy), f"{holder.cidade}/{holder.uf}  CEP {holder.cep}", fnt_dado); yy += 28
    draw_text(draw, (cx1, yy), f"Matrícula: {holder.instalacao}", fnt_dado); yy += 20
    draw_text(draw, (cx1, yy), f"Código cliente: {holder.codigo_cliente}", fnt_dado)

    # Coluna 2: consumo e pagamento.
    yy = 140
    draw_text(draw, (cx2, yy), "CONSUMO", font(11, bold=True), fill=(90, 90, 90)); yy += 18
    draw_text(draw, (cx2, yy), f"Leitura ant.: {cons['leitura_anterior']}", fnt_dado); yy += 20
    draw_text(draw, (cx2, yy), f"Leitura atual: {cons['leitura_atual']}", fnt_dado); yy += 20
    draw_text(draw, (cx2, yy), f"Consumo: {cons['consumo_m3']} m³", fnt_dado); yy += 20
    draw_text(draw, (cx2, yy), f"Valor: {cons['valor_agua']}", fnt_dado); yy += 28
    draw_text(draw, (cx2, yy), f"Vencimento: {dat['vencimento']}", fnt_dado); yy += 20
    draw_text(draw, (cx2, yy), f"Emissão: {dat['emissao']}", fnt_dado); yy += 20
    draw_text(draw, (cx2, yy), f"Referência: {dat['referencia']}", fnt_pequeno)

    draw_line(draw, (MARGIN, h - 60), (w - MARGIN, h - 60), width=1)
    draw_centered(draw, w / 2, h - 42, "DOCUMENTO FICTÍCIO - TESTE", font(11), fill=(150, 150, 150))


def layout_agua_conta_detalhada(img: Image.Image, draw: ImageDraw.ImageDraw, w: int, h: int,
                                emissor: Emitter, holder: Holder, cons: dict, dat: dict,
                                rng: random.Random) -> None:
    """Layout C: conta detalhada com tabela de itens (serviços), cabeçalho à
    esquerda alinhado, itens em linha, valor total destacado."""
    fnt_titulo = font(22, bold=True)
    fnt_sub = font(12)
    fnt_dado = font(15)
    fnt_pequeno = font(11)

    # Cabeçalho à esquerda.
    draw_text(draw, (MARGIN, 58), emissor.nome, fnt_titulo)
    draw_text(draw, (MARGIN, 90), "CONTA DE ÁGUA - DETALHADA", font(13, bold=True))
    draw_text(draw, (MARGIN, 110), f"CNPJ {emissor.cnpj}", fnt_pequeno)
    draw_text(draw, (MARGIN, 128), f"{emissor.cidade}/{emissor.uf}", fnt_pequeno)
    draw_line(draw, (MARGIN, 146), (w - MARGIN, 146), width=2)

    # Dados do titular (linhas curtas, alinhado à esquerda).
    yy = 164
    draw_text(draw, (MARGIN, yy), f"Titular: {holder.nome}", fnt_dado); yy += 22
    draw_text(draw, (MARGIN, yy), f"CPF: {holder.cpf}", fnt_dado); yy += 22
    draw_text(draw, (MARGIN, yy), f"Endereço: {holder.endereco}", fnt_dado); yy += 22
    draw_text(draw, (MARGIN, yy), f"{holder.cidade}/{holder.uf} - CEP {holder.cep}", fnt_dado); yy += 32

    # Tabela de itens.
    draw_text(draw, (MARGIN, yy), "ITENS DA CONTA", font(11, bold=True), fill=(80, 80, 80)); yy += 18
    col_x = [MARGIN, MARGIN + 220, MARGIN + 380]
    headers = ["Descrição", "Quantidade", "Valor (R$)"]
    for cx, htxt in zip(col_x, headers):
        draw_text(draw, (cx, yy), htxt, font(11, bold=True), fill=(80, 80, 80))
    yy += 20
    draw_line(draw, (MARGIN, yy), (col_x[-1] + 100, yy), width=1)
    yy += 22
    rows = [
        ("Fornecimento de água", cons["consumo_m3"] + " m³", f"R$ {rng.randint(30, 200)},{rng.randint(0,99):02d}"),
        ("Esgoto sanitário", cons["consumo_m3"] + " m³", f"R$ {rng.randint(20, 120)},{rng.randint(0,99):02d}"),
        ("Taxa de iluminação pública", "1", f"R$ {rng.randint(5, 30)},{rng.randint(0,99):02d}"),
    ]
    for desc, qtd, val in rows:
        draw_text(draw, (col_x[0], yy), desc, fnt_dado)
        draw_text(draw, (col_x[1], yy), qtd, fnt_dado)
        draw_text(draw, (col_x[2], yy), val, fnt_dado)
        yy += 24
    draw_line(draw, (MARGIN, yy), (col_x[-1] + 100, yy), width=1)
    yy += 26
    total = f"R$ {rng.randint(80, 350)},{rng.randint(0,99):02d}"
    draw_text(draw, (col_x[0], yy), f"TOTAL: {total}", font(16, bold=True))

    # Datas e códigos abaixo da tabela.
    yy += 34
    draw_text(draw, (MARGIN, yy), f"Emissão: {dat['emissao']}      Vencimento: {dat['vencimento']}", fnt_dado); yy += 22
    draw_text(draw, (MARGIN, yy), f"Instalação: {holder.instalacao}      Código do cliente: {holder.codigo_cliente}", fnt_dado); yy += 22
    draw_text(draw, (MARGIN, yy), f"Referência: {dat['referencia']}", fnt_pequeno)

    draw_line(draw, (MARGIN, h - 60), (w - MARGIN, h - 60), width=1)
    draw_centered(draw, w / 2, h - 42, "DOCUMENTO FICTÍCIO - TESTE", font(11), fill=(150, 150, 150))


LAYOUTS_AGUA = [
    layout_agua_bloco_conta,
    layout_agua_dois_colunas,
    layout_agua_conta_detalhada,
]


# ===========================================================================
# Degradações de qualidade (casos difíceis, realistas)
# ===========================================================================

def aplicar_ruido(img: Image.Image, rng: random.Random, intensidade: int = 8) -> Image.Image:
    """Adiciona ruído sal-e-pimenta leve."""
    px = img.load()
    wd, ht = img.size
    for _ in range(wd * ht * intensidade // 200):
        x = rng.randint(0, wd - 1)
        y = rng.randint(0, ht - 1)
        px[x, y] = (rng.choice([0, 255]), rng.choice([0, 255]), rng.choice([0, 255]))
    return img


def aplicar_inclinacao(img: Image.Image, rng: random.Random, angulo_max: float = 3.0) -> Image.Image:
    """Inclina levemente o documento (graus)."""
    angulo = rng.uniform(-angulo_max, angulo_max)
    return img.rotate(angulo, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))


def aplicar_contraste_baixo(img: Image.Image, fator: float = 0.5) -> Image.Image:
    """Reduz o contraste (documento pálido, difícil de ler)."""
    return ImageOps.autocontrast(img, cutoff=0) if False else Image.eval(
        img, lambda px: int(128 + (px - 128) * fator)
    )


def aplicar_desfoco(img: Image.Image, raio: float = 1.2) -> Image.Image:
    """Desfoco leve (impressão borrada)."""
    return img.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(raio))


def aplicar_escurecimento(img: Image.Image, rng: random.Random) -> Image.Image:
    """Escurece partes aleatórias (mancha de impressão)."""
    px = img.load()
    wd, ht = img.size
    for _ in range(rng.randint(2, 6)):
        cx = rng.randint(30, wd - 30)
        cy = rng.randint(30, ht - 30)
        raio = rng.randint(15, 45)
        for x in range(max(0, cx - raio), min(wd, cx + raio)):
            for y in range(max(0, cy - raio), min(ht, cy + raio)):
                if (x - cx) ** 2 + (y - cy) ** 2 < raio ** 2:
                    px[x, y] = (rng.randint(0, 60), rng.randint(0, 60), rng.randint(0, 60))
    return img


def preparar_imagem_final(img: Image.Image, rng: random.Random, modo: str) -> Image.Image:
    """Aplica degradações conforme o modo de qualidade solicitado."""
    if modo == "limpo":
        return img
    if modo == "escaneado":
        # Simula digitalização: leve inclinação + ruído mínimo.
        img = aplicar_inclinacao(img, rng, angulo_max=1.5)
        img = aplicar_ruido(img, rng, intensidade=3)
        return img
    if modo == "baixo_contraste":
        img = aplicar_contraste_baixo(img, fator=0.45)
        img = aplicar_inclinacao(img, rng, angulo_max=2.0)
        return img
    if modo == "desfocado":
        img = aplicar_desfoco(img, raio=1.5)
        img = aplicar_ruido(img, rng, intensidade=6)
        return img
    if modo == "manchado":
        img = aplicar_escurecimento(img, rng)
        img = aplicar_inclinacao(img, rng, angulo_max=2.5)
        return img
    if modo == "baixa_resolucao":
        wd, ht = img.size
        pequena = img.resize((wd // 2, ht // 2), resample=Image.BILINEAR)
        return pequena.resize((wd, ht), resample=Image.BILINEAR)
    return img


# ===========================================================================
# Montagem de PDF: digital (camada de texto) vs escaneado (raster)
# ===========================================================================

def montar_pdf_digital(conteudo_paginas: list[list[tuple[str, float, float, int, bool]]],
                       path: str) -> None:
    """Constrói um PDF com camada de texto (PDF digital) usando reportlab.

    Cada página é uma lista de tuplas (texto, x, y, tamanho, negrito).
    """
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter

    c = canvas.Canvas(path, pagesize=letter)
    wd, ht = letter
    for linhas in conteudo_paginas:
        for texto, x, y, tamanho, negrito in linhas:
            c.setFont("Helvetica-Bold" if negrito else "Helvetica", tamanho)
            c.drawString(x, ht - y, texto)
        c.showPage()
    c.save()


def montar_pdf_escaneado(img: Image.Image, path: str, dpi: int = 150) -> None:
    """Salva a imagem como PDF de 1 página (raster, sem camada de texto)."""
    save_pdf(img, path, dpi=dpi)


# ===========================================================================
# Geração dos documentos
# ===========================================================================

def _emitir_layout(layout_fn: Callable, emissor: Emitter, holder: Holder,
                   cons: dict, dat: dict, rng: random.Random) -> Image.Image:
    img, draw = new_canvas()
    # Marca d'água por trás do conteúdo.
    watermark(draw, WIDTH_PT, HEIGHT_PT)
    layout_fn(img, draw, WIDTH_PT, HEIGHT_PT, emissor, holder, cons, dat, rng)
    return img


def gerar_documento(tipo: str, emissor: Emitter, layout_fn: Callable,
                    indice: int, em_idx: int, layout_idx: int,
                    modo_qualidade: str, saida: str) -> Holder:
    """Gera um único documento sintético e salva em `saida`."""
    rng = random.Random(SEED + indice * 1000 + (em_idx * 100 + layout_idx * 10))
    holder = titular(emissor, rng)
    cons = consumo_energia(rng) if tipo == "energia" else consumo_agua(rng)
    dat = datas(rng)

    img = _emitir_layout(layout_fn, emissor, holder, cons, dat, rng)
    img = preparar_imagem_final(img, rng, modo_qualidade)

    montar_pdf_escaneado(img, saida, dpi=200)

    return holder


# ---------------------------------------------------------------------------
# Catálogo de fixtures a gerar (10 documentos: 5 energia + 5 água)
# ---------------------------------------------------------------------------

FIXTURES = [
    # (arquivo_relativo, tipo, emissor_idx, layout_idx, modo_qualidade)
    ("energy/sp/energy-sp-001.pdf", "energia", 0, 0, "limpo"),           # SP, layout A, digital
    ("energy/rj/energy-rj-002.pdf", "energia", 1, 1, "escaneado"),       # RJ, layout B, escaneado
    ("energy/mg/energy-mg-003.pdf", "energia", 2, 2, "limpo"),           # MG, layout C, digital
    ("energy/sp/energy-sp-004.pdf", "energia", 0, 1, "baixo_contraste"), # SP, layout B, baixo contraste
    ("energy/rj/energy-rj-005.pdf", "energia", 1, 2, "manchado"),        # RJ, layout C, manchado
    ("water/sp/water-sp-001.pdf", "agua", 3, 0, "limpo"),                # SP, layout A, digital
    ("water/rj/water-rj-002.pdf", "agua", 4, 1, "escaneado"),            # RJ, layout B, escaneado
    ("water/mg/water-mg-003.pdf", "agua", 5, 2, "limpo"),                # MG, layout C, digital
    ("water/es/water-es-004.pdf", "agua", 6, 0, "baixa_resolucao"),      # ES, layout A, baixa resolução
    ("water/sp/water-sp-005.pdf", "agua", 3, 2, "desfocado"),            # SP, layout C, desfocado
]


def main() -> None:
    """Gera todas as fixtures sintéticas."""
    emissores_lista = emissores()
    layouts_energia = LAYOUTS_ENERGIA
    layouts_agua = LAYOUTS_AGUA

    gerados: list[dict] = []
    for i, (rel, tipo, em_idx, layout_idx, modo) in enumerate(FIXTURES):
        emissor = emissores_lista[em_idx]
        layout_fn = layouts_energia[layout_idx] if tipo == "energia" else layouts_agua[layout_idx]
        saida = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(saida), exist_ok=True)
        holder = gerar_documento(tipo, emissor, layout_fn, i, em_idx, layout_idx, modo, saida)
        gerados.append({
            "arquivo": rel,
            "tipo": tipo,
            "emissor": emissor.nome,
            "uf": emissor.uf,
            "layout": f"v{emissor.layout_version}",
            "qualidade": modo,
            "titular": holder.nome,
            "cpf": holder.cpf,
            "endereco": holder.endereco,
            "cep": holder.cep,
            "cidade": holder.cidade,
            "instalacao": holder.instalacao,
            "codigo_cliente": holder.codigo_cliente,
        })
        print(f"[ok] {rel} ({tipo}, {emissor.uf}, {modo})")

    print(f"\n{len(gerados)} fixtures geradas em {ROOT}")


if __name__ == "__main__":
    main()
