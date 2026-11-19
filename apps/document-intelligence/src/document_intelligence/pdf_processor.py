"""Processamento de PDFs com extração de camada textual e OCR de fallback.

Separa as responsabilidades:

1. **Extração de texto de PDFs digitais** — pypdfium2 extrai a camada de texto
   embutida quando disponível e utilizável.
2. **Renderização de PDFs escaneados** — páginas sem texto utilizável são
   renderizadas como imagens (pypdfium2 + Pillow).
3. **OCR de imagens** — Tesseract processa as imagens renderizadas.
4. **Normalização dos resultados** — converte saídas brutas em elementos do
   contrato (páginas, blocos, coordenadas, confiança).
5. **Construção do contrato HTTP** — monta o ``ParseResponse`` existente.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

from .config import settings
from .logging import get_logger
from .ocr import (
    CONTRACT_VERSION,
    PROCESSOR_NAME,
    TesseractNotAvailableError,
    _POINTS_PER_INCH,
    ocr_image,
    tesseract_version,
)
from .schemas import (
    BBox,
    DocumentElement,
    DocumentInfo,
    Page,
    ParseResponse,
    ProcessingMetadata,
)
from .security import inspect_pdf

logger = get_logger("document-intelligence.pdf_processor")

# Número mínimo de caracteres por página para considerar a camada textual
# "utilizável". Abaixo disso, a página é tratada como escaneada e passa por OCR.
_MIN_USABLE_TEXT_CHARS = 10

# Mantido para compatibilidade com testes existentes. A detecção de páginas
# mistas agora usa _MIN_IMAGE_AREA_RATIO em vez do tamanho do texto.
_MIN_TEXT_LAYER_FOR_FULL_PAGE = 100

# Fração mínima da área da página ocupada por imagens para disparar OCR.
# Um limiar baixo (1%) evita descartar silenciosamente imagens pequenas que
# podem conter conteúdo documental relevante (endereço, titular, etc.), mesmo
# quando a camada textual é extensa. Páginas sem imagem seguem o caminho
# rápido de camada textual.
_MIN_IMAGE_AREA_RATIO = 0.01

# Espaços em branco colapsados.
_WS_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class _PageTextResult:
    """Resultado da extração/OCR de uma única página."""

    page_number: int
    text: str
    elements: list[DocumentElement]
    width: float | None
    height: float | None
    source: str  # "text_layer" ou "ocr"


def _normalize_text(text: str) -> str:
    """Colapsa espaços por linha, preservando quebras e removendo linhas vazias."""
    lines = []
    for line in text.splitlines():
        line = _WS_RE.sub(" ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _page_size_points(document: pdfium.PdfDocument, page_index: int) -> tuple[float, float]:
    """Devolve (largura, altura) da página em pontos PDF.

    Usa ``page.get_size()`` que respeita CropBox e rotação, garantindo que as
    dimensões coincidam com o frame efetivamente renderizado por
    ``page.render()``. Em PDFs com CropBox menor que MediaBox, evita que as
    bounding boxes do OCR fiquem inconsistentes com as dimensões reportadas.
    """
    page = document[page_index]
    size = page.get_size()
    width = float(size[0])
    height = float(size[1])
    return width, height


def _extract_text_layer(
    document: pdfium.PdfDocument,
    page_index: int,
    page_number: int,
) -> _PageTextResult | None:
    """Extrai a camada textual de uma página digital.

    Retorna ``None`` quando não há texto utilizável (página escaneada, camada
    vazia ou corrompida), para que o chamador recorra ao OCR.
    """
    page = document[page_index]
    width, height = _page_size_points(document, page_index)

    try:
        textpage = page.get_textpage()
        raw_text = textpage.get_text_range() or ""
    except Exception as exc:  # pragma: no cover - falha de infraestrutura
        logger.warning(
            "falha_extrair_camada_textual",
            page_number=page_number,
            error_type=type(exc).__name__,
        )
        return None

    text = _normalize_text(raw_text)
    if len(text) < _MIN_USABLE_TEXT_CHARS:
        return None

    element = DocumentElement(
        id=f"p{page_number}-layer-1",
        type="text",
        text=text,
        bbox=None,
        confidence=None,
        table=None,
        image_ref=None,
        metadata={"source": "text_layer"},
    )

    return _PageTextResult(
        page_number=page_number,
        text=text,
        elements=[element],
        width=width,
        height=height,
        source="text_layer",
    )


# Limite de caracteres da camada textual acima do qual a página é considerada
# "completa" e imagens adicionais são tratadas como decorativas. Abaixo desse
# limite, a presença de imagens indica conteúdo escaneado não capturado pelo
# texto (página mista).
_MIN_TEXT_LAYER_FOR_FULL_PAGE = 100


def _page_has_images(document: pdfium.PdfDocument, page_index: int) -> bool:
    """Verifica se a página contém objetos de imagem (escaneados ou embutidos)."""
    page = document[page_index]
    images = list(page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE]))
    return len(images) > 0


def _page_image_area_ratio(
    document: pdfium.PdfDocument, page_index: int
) -> float:
    """Devolve a fração da área da página ocupada por imagens (0.0 a 1.0).

    Usa ``get_bounds()`` (pypdfium2 >= 5) com fallback para ``get_pos()``
    (pypdfium2 4.x) para calcular a área de cada objeto de imagem e compara
    com a área da página. Retorna 0.0 quando não há imagens ou não é possível
    obter as dimensões.
    """
    page = document[page_index]
    size = page.get_size()
    page_width = float(size[0])
    page_height = float(size[1])
    if page_width <= 0 or page_height <= 0:
        return 0.0

    page_area = page_width * page_height
    image_area = 0.0

    for obj in page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE]):
        bounds = None
        try:
            bounds = obj.get_bounds()  # pypdfium2 >= 5
        except AttributeError:
            try:
                bounds = obj.get_pos()  # pypdfium2 4.x
            except AttributeError:  # pragma: no cover - versão não suportada
                bounds = None
        if bounds is None:
            continue
        try:
            img_width = float(bounds[2] - bounds[0])
            img_height = float(bounds[3] - bounds[1])
            if img_width > 0 and img_height > 0:
                image_area += img_width * img_height
        except (TypeError, ValueError, IndexError):  # pragma: no cover
            continue

    return min(image_area / page_area, 1.0) if page_area > 0 else 0.0


def _ocr_page(
    document: pdfium.PdfDocument,
    page_index: int,
    page_number: int,
) -> _PageTextResult:
    """Renderiza uma página e executa OCR com Tesseract."""
    width_pts, height_pts = _page_size_points(document, page_number - 1)

    import tempfile

    # Renderiza a página diretamente do documento já aberto (evita reabrir o PDF).
    scale = getattr(settings, "ocr_dpi", 200) / _POINTS_PER_INCH
    page = document[page_index]
    pil_image = page.render(scale=scale).to_pil()
    if pil_image.mode not in ("RGB", "L", "RGBA"):
        pil_image = pil_image.convert("RGB")
    width_px, height_px = pil_image.size

    # Preserva caminhos separados: original e pré-processado.
    fd, original_image_path = tempfile.mkstemp(
        prefix=f"di-ocr-p{page_number}-", suffix=".png", dir=settings.temp_dir
    )
    os.close(fd)

    # Inicializa antes do try para que o finally possa limpar mesmo se
    # pil_image.save() falhar.
    preprocessed_image_path = original_image_path

    try:
        pil_image.save(original_image_path, format="PNG")

        if getattr(settings, "ocr_preprocess", False):
            try:
                from .ocr import preprocess_image_for_ocr

                preprocessed_image_path = preprocess_image_for_ocr(original_image_path)
            except Exception as exc:  # pragma: no cover - falha de OpenCV
                logger.warning(
                    "falha_preprocessamento_ocr",
                    page_number=page_number,
                    error_type=type(exc).__name__,
                )

        lang = getattr(settings, "ocr_lang", "por")
        lines = ocr_image(
            preprocessed_image_path,
            lang=lang,
            page_width_px=width_px,
            page_height_px=height_px,
            dpi=getattr(settings, "ocr_dpi", 200),
        )

        elements: list[DocumentElement] = []
        text_parts: list[str] = []
        for line_index, line in enumerate(lines):
            element = DocumentElement(
                id=f"p{page_number}-ocr-l{line_index}",
                type="text",
                text=line.text,
                bbox=BBox(
                    x1=line.x1,
                    y1=line.y1,
                    x2=line.x2,
                    y2=line.y2,
                ),
                confidence=line.confidence,
                table=None,
                image_ref=None,
                metadata={
                    "source": "ocr",
                    "ocr_engine": "tesseract",
                    "ocr_lang": lang,
                    "word_count": line.word_count,
                },
            )
            elements.append(element)
            if line.text:
                text_parts.append(line.text)

        full_text = "\n".join(text_parts)

        return _PageTextResult(
            page_number=page_number,
            text=full_text,
            elements=elements,
            width=width_pts,
            height=height_pts,
            source="ocr",
        )
    finally:
        # Remove todos os arquivos temporários criados durante o processamento.
        for path in (preprocessed_image_path, original_image_path):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def _process_pdf_pages(
    pdf_path: str,
) -> tuple[list[_PageTextResult], int, bool]:
    """Processa todas as páginas de um PDF.

    Devolve ``(resultados_por_pagina, total_paginas, alguma_pagina_usou_ocr)``.
    A ordem das páginas é preservada estritamente.
    """
    document = pdfium.PdfDocument(pdf_path)
    try:
        page_count = len(document)
        if page_count == 0:
            return [], 0, False

        results: list[_PageTextResult] = []
        any_ocr = False

        for page_index in range(page_count):
            page_number = page_index + 1

            layer_result = _extract_text_layer(document, page_index, page_number)

            if layer_result is not None:
                # Camada textual utilizável. Verifica se há imagens que podem
                # conter conteúdo não capturado pelo texto (página mista).
                image_ratio = _page_image_area_ratio(document, page_index)
                if image_ratio >= _MIN_IMAGE_AREA_RATIO:
                    # Página mista: texto + imagem relevante → também OCR para
                    # não perder conteúdo nas imagens. Mantém o texto da camada
                    # e acrescenta o do OCR sem descartar nenhum dos dois.
                    any_ocr = True
                    ocr_result = _ocr_page(document, page_index, page_number)
                    combined_text = layer_result.text + "\n" + ocr_result.text
                    combined_elements = layer_result.elements + ocr_result.elements
                    results.append(
                        _PageTextResult(
                            page_number=page_number,
                            text=combined_text,
                            elements=combined_elements,
                            width=layer_result.width,
                            height=layer_result.height,
                            source="mixed",
                        )
                    )
                else:
                    # Página totalmente digital: camada textual suficiente,
                    # imagens (se houver) são pequenas/decorativas.
                    results.append(layer_result)
                continue

            any_ocr = True
            ocr_result = _ocr_page(document, page_index, page_number)
            results.append(ocr_result)

        return results, page_count, any_ocr
    finally:
        document.close()


def build_parse_response(
    pdf_path: str,
    document_id: str,
    size_bytes: int = 0,
    mime_type: str = "application/pdf",
) -> ParseResponse:
    """Processa um PDF e monta o :class:`ParseResponse` do contrato existente."""
    import time

    start = time.perf_counter()
    warnings: list[str] = []

    try:
        page_count = inspect_pdf(pdf_path, max_pages=settings.max_pages)

        if page_count > settings.max_pages:
            warnings.append(
                f"PDF tem {page_count} páginas; o limite configurado é "
                f"{settings.max_pages}."
            )

        results, _, any_ocr = _process_pdf_pages(pdf_path)

        pages: list[Page] = []
        all_text_parts: list[str] = []

        for result in results:
            all_text_parts.append(result.text)
            pages.append(
                Page(
                    page_number=result.page_number,
                    elements=result.elements,
                    width=result.width,
                    height=result.height,
                )
            )

        full_text = "\n".join(part for part in all_text_parts if part)
        markdown = _text_to_markdown(full_text)

        processing_time_ms = int((time.perf_counter() - start) * 1000)

        if any_ocr:
            warnings.append(
                "Uma ou mais páginas não tiveram camada textual utilizável e "
                "foram processadas por OCR (Tesseract)."
            )

        return ParseResponse(
            document_id=document_id,
            status="completed",
            document=DocumentInfo(
                mime_type=mime_type,
                page_count=page_count,
                size_bytes=size_bytes,
            ),
            content={
                "text": full_text,
                "markdown": markdown,
            },
            pages=pages,
            metadata=ProcessingMetadata(
                processor=PROCESSOR_NAME,
                processor_version=_tesseract_version_str(),
                processing_time_ms=processing_time_ms,
                contract_version=CONTRACT_VERSION,
            ),
            warnings=warnings,
        )

    except TesseractNotAvailableError as exc:
        logger.error(
            "erro_tesseract_nao_disponível",
            document_id=document_id,
            error=str(exc),
        )
        processing_time_ms = int((time.perf_counter() - start) * 1000)
        return _failed_response(
            document_id,
            size_bytes,
            processing_time_ms,
            error_code="TESSERACT_NOT_AVAILABLE",
            error_message="Tesseract não está disponível para processamento.",
        )
    except Exception as exc:  # pragma: no cover - falha de infraestrutura
        logger.error(
            "erro_no_processador_pdf",
            document_id=document_id,
            error_type=type(exc).__name__,
        )
        processing_time_ms = int((time.perf_counter() - start) * 1000)
        return _failed_response(
            document_id,
            size_bytes,
            processing_time_ms,
            error_code="PROCESSING_FAILED",
            error_message="Falha ao processar o documento.",
        )


def _text_to_markdown(text: str) -> str:
    """Converte texto simples em markdown básico (quebras de linha preservadas)."""
    if not text:
        return ""
    return "\n".join(text.splitlines())


def _tesseract_version_str() -> str:
    version = tesseract_version()
    return version if version else "unknown"


def _failed_response(
    document_id: str,
    size_bytes: int,
    processing_time_ms: int,
    *,
    error_code: str,
    error_message: str,
) -> ParseResponse:
    """Constrói uma resposta ``failed`` sem vazar detalhes internos."""
    return ParseResponse(
        document_id=document_id,
        status="failed",
        document=DocumentInfo(
            mime_type="application/pdf",
            page_count=0,
            size_bytes=size_bytes,
        ),
        content={},
        pages=[],
        metadata=ProcessingMetadata(
            processor=PROCESSOR_NAME,
            processor_version=_tesseract_version_str(),
            processing_time_ms=processing_time_ms,
            contract_version=CONTRACT_VERSION,
        ),
        warnings=[],
        error_code=error_code,
        error_message=error_message,
    )
