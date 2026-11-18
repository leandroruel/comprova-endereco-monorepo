"""Mecanismo de OCR baseado no Tesseract 5.

Substitui o Marker/Surya por OCR convencional, local e sem dependência de VLM.

Responsabilidades:
- Verificar disponibilidade do binário ``tesseract`` e do idioma ``por``.
- Executar OCR sobre imagens, retornando palavras com bounding boxes e confiança.
- Usar a saída TSV do Tesseract como fonte de palavras, coordenadas e confiança.
- Nunca inventar confiança: palavras sem reconhecimento confiável recebem
  ``conf=-1`` e são sinalizadas honestamente.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any

from .config import settings
from .logging import get_logger

logger = get_logger("document-intelligence.ocr")

# Idioma padrão do OCR (português do Brasil).
DEFAULT_LANG = "por"

# Versão do contrato JSON de saída.
CONTRACT_VERSION = "1.0"

# Nome do processador utilizado (substitui "marker").
PROCESSOR_NAME = "tesseract"

# Escala de coordenadas: Tesseract devolve pixels; o contrato usa pontos PDF
# (72 pt = 1 polegada). A renderização é feita a ``OCR_DPI`` DPI.
OCR_DPI = 200
_POINTS_PER_INCH = 72.0
_PIXEL_TO_POINT = _POINTS_PER_INCH / OCR_DPI  # 0.36


@dataclass(frozen=True)
class OcrWord:
    """Uma palavra reconhecida pelo Tesseract com caixa e confiança."""

    text: str
    left: int
    top: int
    width: int
    height: int
    confidence: float
    block_num: int
    par_num: int
    line_num: int
    word_num: int


@dataclass(frozen=True)
class OcrLine:
    """Uma linha de texto: palavras agrupadas, caixa unida e confiança média."""

    text: str
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float | None
    word_count: int


class TesseractNotAvailableError(RuntimeError):
    """O binário do Tesseract ou o idioma necessário não estão disponíveis."""


def _tesseract_binary() -> str | None:
    """Caminho do binário ``tesseract``, se instalado no PATH."""
    return shutil.which("tesseract")


def tesseract_version() -> str | None:
    """Versão instalada do Tesseract (ex. ``5.3.4``) ou ``None``."""
    binary = _tesseract_binary()
    if binary is None:
        return None
    try:
        result = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        match = re.search(r"(\d+\.\d+\.\d+)", result.stdout)
        return match.group(1) if match else "unknown"
    except Exception:  # pragma: no cover - falha de ambiente
        return None


def is_tesseract_available() -> bool:
    """``True`` se o Tesseract está instalado e o idioma ``por`` existe."""
    binary = _tesseract_binary()
    if binary is None:
        return False
    try:
        result = subprocess.run(
            [binary, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        langs = result.stdout.splitlines()
        # A primeira linha é o cabeçalho "Available languages: ...".
        return any(DEFAULT_LANG in line for line in langs)
    except Exception:  # pragma: no cover - falha de ambiente
        return False


def _run_tesseract_tsv(image_path: str, lang: str = DEFAULT_LANG) -> str:
    """Executa o Tesseract com saída TSV e devolve o texto bruto."""
    binary = _tesseract_binary()
    if binary is None:
        raise TesseractNotAvailableError("tesseract não está instalado")
    try:
        result = subprocess.run(
            [
                binary,
                image_path,
                "stdout",
                "-l",
                lang,
                "--psm",
                "3",  # segmentação automática completa (página)
                "tsv",
            ],
            capture_output=True,
            text=True,
            timeout=settings.timeout_s,
            check=True,
        )
        return result.stdout
    except subprocess.TimeoutExpired as exc:
        raise TesseractNotAvailableError(
            f"tesseract excedeu o timeout de {settings.timeout_s}s"
        ) from exc
    except subprocess.CalledProcessError as exc:
        logger.error(
            "erro_no_tesseract",
            error_type=type(exc).__name__,
            error=str(exc),
            stderr=exc.stderr[:500] if exc.stderr else None,
        )
        raise TesseractNotAvailableError(
            f"tesseract falhou com código {exc.returncode}"
        ) from exc


def _parse_tsv(tsv_output: str) -> list[OcrWord]:
    """Analisa a saída TSV do Tesseract e devolve palavras reconhecidas.

    A linha de cabeçalho é ignorada. Linhas com ``conf == -1`` ou texto vazio
    (espaços, quebras) são descartadas — não inventamos confiança para o que
    não foi reconhecido.
    """
    words: list[OcrWord] = []
    lines = tsv_output.splitlines()
    if not lines:
        return words

    # Primeira linha é o cabeçalho.
    header = lines[0].split("\t")
    col_index = {name: i for i, name in enumerate(header)}

    required = ("level", "page_num", "block_num", "par_num", "line_num",
                "word_num", "left", "top", "width", "height", "conf", "text")
    if not all(col in col_index for col in required):
        logger.warning("tsv_cabecalho_inesperado", colunas=list(col_index.keys()))
        return words

    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) <= col_index["text"]:
            continue
        try:
            level = int(fields[col_index["level"]])
            # Só palavras (nível 5) carregam texto reconhecível.
            if level != 5:
                continue
            text = fields[col_index["text"]]
            if not text or not text.strip():
                continue
            conf = float(fields[col_index["conf"]])
            if conf < 0:
                # Confiança negativa = não reconhecido; descarta honestamente.
                continue
            words.append(
                OcrWord(
                    text=text,
                    left=int(fields[col_index["left"]]),
                    top=int(fields[col_index["top"]]),
                    width=int(fields[col_index["width"]]),
                    height=int(fields[col_index["height"]]),
                    confidence=conf,
                    block_num=int(fields[col_index["block_num"]]),
                    par_num=int(fields[col_index["par_num"]]),
                    line_num=int(fields[col_index["line_num"]]),
                    word_num=int(fields[col_index["word_num"]]),
                )
            )
        except (ValueError, IndexError):
            # Linha malformada: ignora sem quebrar o processamento.
            continue

    return words


def _words_to_lines(
    words: list[OcrWord], page_width_px: int, page_height_px: int
) -> list[OcrLine]:
    """Agrupa palavras por bloco/linha e devolve linhas com caixa unida.

    As coordenadas são convertidas de pixels (Tesseract, origem topo-esquerda)
    para pontos PDF (origem baixo-esquerda), com escala ``72 / OCR_DPI``.
    """
    scale = _PIXEL_TO_POINT
    # Agrupa palavras por (block_num, par_num, line_num), preservando ordem.
    groups: dict[tuple[int, int, int], list[OcrWord]] = {}
    for word in words:
        key = (word.block_num, word.par_num, word.line_num)
        groups.setdefault(key, []).append(word)

    lines: list[OcrLine] = []
    for key in sorted(groups.keys()):
        group_words = sorted(groups[key], key=lambda w: w.word_num)
        text = " ".join(w.text for w in group_words)
        if not text.strip():
            continue

        # Caixa unida em pixels (origem topo-esquerda).
        min_left = min(w.left for w in group_words)
        max_right = max(w.left + w.width for w in group_words)
        min_top = min(w.top for w in group_words)
        max_bottom = max(w.top + w.height for w in group_words)

        # Conversão para pontos PDF (origem baixo-esquerda).
        x1 = min_left * scale
        x2 = max_right * scale
        # no PDF (origem baixo-esquerda), y cresce para cima:
        # a linha de topo da imagem fica com y2 grande (perto do topo da página).
        y1 = (page_height_px - max_bottom) * scale
        y2 = (page_height_px - min_top) * scale

        confs = [w.confidence for w in group_words if w.confidence >= 0]
        avg_conf = sum(confs) / len(confs) if confs else None

        lines.append(
            OcrLine(
                text=text,
                x1=round(x1, 2),
                y1=round(y1, 2),
                x2=round(x2, 2),
                y2=round(y2, 2),
                confidence=round(avg_conf, 2) if avg_conf is not None else None,
                word_count=len(group_words),
            )
        )

    return lines


def ocr_image(
    image_path: str,
    lang: str = DEFAULT_LANG,
    page_width_px: int | None = None,
    page_height_px: int | None = None,
) -> list[OcrLine]:
    """Executa OCR em uma imagem e devolve linhas reconhecidas.

    Se ``page_width_px``/``page_height_px`` forem fornecidos, as coordenadas
    são convertidas para pontos PDF; caso contrário, permanecem em pixels.
    """
    if not is_tesseract_available():
        raise TesseractNotAvailableError(
            "tesseract ou o idioma 'por' não estão disponíveis"
        )

    tsv_output = _run_tesseract_tsv(image_path, lang=lang)
    words = _parse_tsv(tsv_output)

    if page_width_px is not None and page_height_px is not None:
        return _words_to_lines(words, page_width_px, page_height_px)

    # Sem conversão: devolve linhas com coordenadas em pixels (mantido para
    # uso direto de imagens, não-PDF).
    lines: list[OcrLine] = []
    scale = 1.0
    groups: dict[tuple[int, int, int], list[OcrWord]] = {}
    for word in words:
        key = (word.block_num, word.par_num, word.line_num)
        groups.setdefault(key, []).append(word)
    for key in sorted(groups.keys()):
        group_words = sorted(groups[key], key=lambda w: w.word_num)
        text = " ".join(w.text for w in group_words)
        if not text.strip():
            continue
        min_left = min(w.left for w in group_words)
        max_right = max(w.left + w.width for w in group_words)
        min_top = min(w.top for w in group_words)
        max_bottom = max(w.top + w.height for w in group_words)
        confs = [w.confidence for w in group_words if w.confidence >= 0]
        avg_conf = sum(confs) / len(confs) if confs else None
        lines.append(
            OcrLine(
                text=text,
                x1=round(min_left * scale, 2),
                y1=round(min_top * scale, 2),
                x2=round(max_right * scale, 2),
                y2=round(max_bottom * scale, 2),
                confidence=round(avg_conf, 2) if avg_conf is not None else None,
                word_count=len(group_words),
            )
        )
    return lines


def render_page_to_image(
    pdf_path: str,
    page_number: int,
    dpi: int = OCR_DPI,
    output_path: str | None = None,
) -> tuple[str, int, int]:
    """Renderiza uma página de PDF em imagem (PNG) para OCR.

    Devolve ``(caminho_da_imagem, largura_px, altura_px)``.
    """
    import pypdfium2 as pdfium
    from PIL import Image

    document = pdfium.PdfDocument(pdf_path)
    try:
        page_index = page_number - 1
        if page_index < 0 or page_index >= len(document):
            raise IndexError(
                f"página {page_number} fora do intervalo (1-{len(document)})"
            )
        page = document[page_index]
        # Renderiza em escala ``dpi / 72`` (pypdfium2 escala relativa a 72 DPI).
        scale = dpi / _POINTS_PER_INCH
        pil_image = page.render(scale=scale).to_pil()
        # Garante modo compatível com Tesseract.
        if pil_image.mode not in ("RGB", "L", "RGBA"):
            pil_image = pil_image.convert("RGB")
        width_px, height_px = pil_image.size

        if output_path is None:
            import tempfile

            fd, output_path = tempfile.mkstemp(
                prefix=f"di-ocr-p{page_number}-", suffix=".png"
            )
            os_fd = fd
        else:
            os_fd = None

        try:
            pil_image.save(output_path, format="PNG")
        finally:
            if os_fd is not None:
                import os

                os.close(os_fd)

        return output_path, width_px, height_px
    finally:
        document.close()


def preprocess_image_for_ocr(image_path: str) -> str:
    """Aplica pré-processamento leve com OpenCV quando necessário.

    Converte para escala de cinza, aplica binarização adaptativa (Otsu) e
    devolve o caminho da imagem pré-processada. Se a imagem já estiver em boas
    condições, devolve o caminho original inalterado.
    """
    import cv2

    image = cv2.imread(image_path)
    if image is None:
        return image_path

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Binarização com Otsu para melhorar contraste em documentos escaneados.
    _, thresh = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    # Salva a imagem pré-processada ao lado da original.
    import os
    import tempfile

    base, ext = os.path.splitext(image_path)
    preprocessed_path = f"{base}_preprocessed{ext or '.png'}"
    cv2.imwrite(preprocessed_path, thresh)
    return preprocessed_path


def _tesseract_version_for_metadata() -> str:
    """Versão do Tesseract para o campo ``processorVersion``."""
    version = tesseract_version()
    return version if version else "unknown"


def _check_languages() -> dict[str, Any]:
    """Devolve informações sobre idiomas disponíveis no Tesseract."""
    binary = _tesseract_binary()
    if binary is None:
        return {"tesseract_installed": False, "languages": [], "por_available": False}
    try:
        result = subprocess.run(
            [binary, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        langs = [line.strip() for line in result.stdout.splitlines()[1:] if line.strip()]
        return {
            "tesseract_installed": True,
            "languages": langs,
            "por_available": DEFAULT_LANG in langs,
        }
    except Exception:  # pragma: no cover - falha de ambiente
        return {
            "tesseract_installed": True,
            "languages": [],
            "por_available": False,
            "error": "não foi possível listar idiomas",
        }
