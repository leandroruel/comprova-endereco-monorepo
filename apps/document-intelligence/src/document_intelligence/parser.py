"""Wrapper do Marker para extração estruturada de PDF.

Utiliza a API Python oficial do Marker 2.x (``marker_pdf``):

- :func:`marker.models.create_model_dict` para carregar os modelos uma única vez;
- :class:`marker.converters.pdf.PdfConverter` para construir o documento;
- :class:`marker.renderers.json.JSONRenderer` para a árvore estruturada
  (páginas, blocos, ``bbox``, HTML);
- :class:`marker.renderers.markdown.MarkdownRenderer` para o ``content.markdown``.

Nenhum recurso de LLM é habilitado (``use_llm`` permanece ``False``). As
importações do Marker são **lazy** para que o módulo possa ser importado/testado
mesmo quando o Marker não está instalado no ambiente.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from bs4 import BeautifulSoup

from .config import settings
from .logging import get_logger
from .schemas import (
    BBox,
    DocumentElement,
    DocumentInfo,
    Page,
    ParseResponse,
    ProcessingMetadata,
    Table,
    TableCell,
)

logger = get_logger("document-intelligence.parser")

# Versão do contrato JSON de saída.
CONTRACT_VERSION = "1.0"

# Nome do processador utilizado.
PROCESSOR_NAME = "marker"

# ---------------------------------------------------------------------------
# Import lazy do Marker (evita quebrar o import quando não está instalado).
# ---------------------------------------------------------------------------
_create_model_dict: Any = None
_PdfConverter: Any = None
_JSONRenderer: Any = None
_MarkdownRenderer: Any = None


def _import_marker() -> None:
    """Importa os módulos do Marker somente quando necessário."""
    global _create_model_dict, _PdfConverter, _JSONRenderer, _MarkdownRenderer
    if _create_model_dict is not None:
        return
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.renderers.json import JSONRenderer
    from marker.renderers.markdown import MarkdownRenderer

    _create_model_dict = create_model_dict
    _PdfConverter = PdfConverter
    _JSONRenderer = JSONRenderer
    _MarkdownRenderer = MarkdownRenderer


# ---------------------------------------------------------------------------
# Mapeamento de tipos do Marker -> tipos do contrato.
# ---------------------------------------------------------------------------
_TYPE_MAP: dict[str, str] = {
    "SectionHeader": "heading",
    "Text": "text",
    "TextInlineMath": "text",
    "Footnote": "text",
    "Reference": "text",
    "Bibliography": "text",
    "TableOfContents": "text",
    "Table": "table",
    "Picture": "image",
    "Figure": "image",
    "FigureGroup": "image",
    "PictureGroup": "image",
    "Diagram": "image",
    "ChemicalBlock": "image",
    "ComplexRegion": "image",
    "Handwriting": "image",
    "ListGroup": "list",
    "ListItem": "list_item",
    "PageHeader": "page_header",
    "PageFooter": "page_footer",
    "Code": "code_block",
    "Equation": "formula",
    "Caption": "caption",
}


def _normalize_type(block_type: str | None) -> str:
    """Normaliza o tipo do Marker para o conjunto fixo do contrato.

    Tipos desconhecidos viram ``unknown`` (estratégia explícita), mas o texto e
    as coordenadas continuam sendo preservados no elemento.
    """
    if not block_type:
        return "unknown"
    return _TYPE_MAP.get(block_type, "unknown")


# ---------------------------------------------------------------------------
# Imagens (Picture/Figure/Diagram).
#
# O ``JSONRenderer`` do Marker 2.1.0 popula ``JSONBlockOutput.images`` com o
# recorte do bloco já em base64 (JPEG, ver ``marker.settings.OUTPUT_IMAGE_FORMAT``)
# apenas para os tipos em ``JSONRenderer.image_blocks``. A chave do dicionário é
# o id do bloco (``/page/N/Picture/M``). Embutimos o recorte como data URL
# **com tetos** (por imagem e por documento): excedentes ficam sem ``imageRef``
# e são sinalizados em ``metadata`` + ``warnings``, sem inventar referências.
# ---------------------------------------------------------------------------
_IMAGE_MIME_BY_FORMAT: dict[str, str] = {
    "JPEG": "image/jpeg",
    "JPG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}


def _image_mime_type() -> str:
    """MIME do recorte de imagem conforme a configuração efetiva do Marker."""
    try:
        from marker.settings import settings as marker_settings

        fmt = str(getattr(marker_settings, "OUTPUT_IMAGE_FORMAT", "JPEG")).upper()
        return _IMAGE_MIME_BY_FORMAT.get(fmt, "image/jpeg")
    except Exception:  # pragma: no cover - Marker ausente/atributo mudou
        return "image/jpeg"


@dataclass
class _ImageBudget:
    """Orçamento de bytes de imagem embutidos por documento."""

    max_per_image: int
    max_total: int
    used: int = 0

    def take(self, size_bytes: int) -> bool:
        """Reserva ``size_bytes`` se couber nos dois tetos; senão recusa."""
        if size_bytes <= 0 or size_bytes > self.max_per_image:
            return False
        if self.used + size_bytes > self.max_total:
            return False
        self.used += size_bytes
        return True


def _block_image_base64(block: Any) -> tuple[str, int] | None:
    """Devolve ``(base64, size_bytes)`` do recorte do bloco, se houver.

    Usa o id do próprio bloco como chave; se não houver correspondência exata e
    o bloco tiver exatamente uma imagem, usa essa. Nunca inventa: devolve
    ``None`` quando o Marker não forneceu recorte confiável.
    """
    images = getattr(block, "images", None)
    if not isinstance(images, dict) or not images:
        return None
    # As chaves podem ser ``BlockId`` ou ``str``; normaliza para comparar.
    lookup = {str(key): value for key, value in images.items()}
    block_id = str(getattr(block, "id", ""))
    candidate = lookup.get(block_id)
    if not isinstance(candidate, str) or not candidate:
        values = [value for value in lookup.values() if isinstance(value, str) and value]
        if len(values) != 1:
            return None
        candidate = values[0]
    # base64: 4 chars -> 3 bytes (descontando o padding '=').
    padding = len(candidate) - len(candidate.rstrip("="))
    return candidate, (len(candidate) * 3) // 4 - padding


# ---------------------------------------------------------------------------
# Extração de texto e tabelas a partir do HTML do Marker.
# ---------------------------------------------------------------------------
_WS_RE = re.compile(r"[ \t\r\f\v]+")


def _normalize_text(text: str) -> str:
    """Colapsa espaços por linha, preservando quebras e removendo linhas vazias."""
    lines = []
    for line in text.splitlines():
        line = _WS_RE.sub(" ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def html_to_text(html: str | None) -> str:
    """Converte HTML do Marker em texto simples legível."""
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for li in soup.find_all("li"):
        li.insert_before("\n")
        li.insert_after("\n")
    text = soup.get_text(separator="")
    return _normalize_text(text)


def parse_table_html(html: str | None, bbox: BBox | None = None) -> Table | None:
    """Extrai estrutura (headers/rows/cells) de uma tabela HTML do Marker."""
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    table_tag = soup.find("table")
    if table_tag is None:
        return None

    rows: list[list[str]] = []
    headers: list[str] = []
    cells: list[TableCell] = []
    header_row_seen = False

    for row_index, tr in enumerate(table_tag.find_all("tr")):
        cell_tags = tr.find_all(["td", "th"])
        if not cell_tags:
            continue
        row_values: list[str] = []
        is_header_row = all(cell.name == "th" for cell in cell_tags)
        for col_index, cell in enumerate(cell_tags):
            value = _normalize_text(cell.get_text(separator=""))
            row_values.append(value)
            try:
                rowspan = int(cell.get("rowspan", 1))
            except (TypeError, ValueError):
                rowspan = 1
            try:
                colspan = int(cell.get("colspan", 1))
            except (TypeError, ValueError):
                colspan = 1
            cells.append(
                TableCell(
                    text=value,
                    row=row_index,
                    column=col_index,
                    rowspan=max(rowspan, 1),
                    colspan=max(colspan, 1),
                )
            )
        if is_header_row and not header_row_seen and not rows:
            headers = row_values
            header_row_seen = True
        else:
            rows.append(row_values)

    if not headers and not rows:
        return None
    return Table(headers=headers, rows=rows, cells=cells, bbox=bbox)


def table_to_text(table: Table) -> str:
    """Representação textual simples de uma tabela (para ``content.text``)."""
    lines: list[str] = []
    if table.headers:
        lines.append(" | ".join(table.headers))
    for row in table.rows:
        lines.append(" | ".join(row))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
class MarkerParser:
    """Wrapper sobre a API Python do Marker 2.x.

    Os modelos são carregados uma única vez (:meth:`load_models`) e reutilizados
    entre requisições. O :class:`PdfConverter` também é reutilizado: cada
    documento gera builders/processors novos, compartilhando apenas os modelos.
    """

    def __init__(self) -> None:
        """Estado vazio; modelos e locks são criados sob demanda."""
        self._models: dict[str, Any] | None = None
        self._converter: Any = None
        self._json_renderer: Any = None
        self._markdown_renderer: Any = None
        self._loaded = False
        self._warm = False
        # Marker/Surya não é thread-safe: inferências concorrentes no mesmo
        # processo causam segfault. Serializamos a inferência por processo.
        import threading

        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    def load_models(self) -> None:
        """Carrega os modelos do Marker uma única vez (idempotente)."""
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return
            _import_marker()
            logger.info("carregando_modelos_marker")
            start = time.perf_counter()
            self._models = _create_model_dict()
            self._converter = _PdfConverter(artifact_dict=self._models)
            self._json_renderer = self._converter.resolve_dependencies(
                _JSONRenderer
            )
            self._markdown_renderer = self._converter.resolve_dependencies(
                _MarkdownRenderer
            )
            self._loaded = True
            logger.info(
                "modelos_marker_carregados",
                duracao_ms=int((time.perf_counter() - start) * 1000),
            )

    @property
    def models_loaded(self) -> bool:
        """``True`` quando os modelos do Marker já estão carregados."""
        return self._loaded

    @property
    def warm(self) -> bool:
        """``True`` quando o warmup com um PDF sintético concluiu com sucesso."""
        return self._warm

    def warmup(self) -> None:
        """Executa um documento sintético para carregar os modelos de layout/OCR.

        O primeiro documento com tabela/layout carrega pesos adicionais e pode
        levar minutos em CPU. Rodar isto no startup evita que a primeira
        requisição real estoure o timeout.
        """
        if self._warm:
            return
        if not self._loaded:
            self.load_models()

        from .security import temporary_pdf_path
        from .warmup import build_warmup_pdf

        logger.info("aquecendo_modelos_marker")
        start = time.perf_counter()
        try:
            with temporary_pdf_path(
                build_warmup_pdf(), prefix="di-warmup-", dir=settings.temp_dir
            ) as path:
                # parse() captura exceções e devolve status "failed"; um parse
                # com falha NÃO aquece o serviço — /ready deve continuar
                # "not_ready" para o orquestrador não rotear tráfego.
                response = self.parse(path, "warmup", size_bytes=0)
            if response.status != "completed":
                raise RuntimeError(
                    f"aquecimento falhou: {response.error_code}"
                )
            self._warm = True
            logger.info(
                "modelos_marker_aquecidos",
                duracao_ms=int((time.perf_counter() - start) * 1000),
            )
        except Exception as exc:  # pragma: no cover - falha de ambiente
            logger.error(
                "falha_no_aquecimento_dos_modelos",
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

    def parse(
        self, pdf_path: str, document_id: str, size_bytes: int = 0
    ) -> ParseResponse:
        """Executa o Marker no PDF e mapeia o resultado para o contrato."""
        if not self._loaded:
            self.load_models()

        start = time.perf_counter()
        warnings: list[str] = []

        try:
            # Constrói o documento uma única vez (a etapa cara). A inferência é
            # serializada: os modelos locais do Marker não são thread-safe.
            with self._inference_lock:
                document = self._converter.build_document(pdf_path)

                # JSON estruturado (páginas, blocos, bbox, HTML) e markdown.
                json_output = self._json_renderer(document)
                markdown_output = self._markdown_renderer(document)

            page_count = len(document.pages)
            if page_count > settings.max_pages:
                warnings.append(
                    f"PDF tem {page_count} páginas; o limite configurado é "
                    f"{settings.max_pages}. O processamento pode ter sido limitado."
                )

            # Orçamento de imagens compartilhado por todo o documento.
            image_budget = (
                _ImageBudget(
                    max_per_image=settings.max_image_bytes,
                    max_total=settings.max_total_image_bytes,
                )
                if settings.include_images
                else None
            )

            pages: list[Page] = []
            all_text_parts: list[str] = []

            for page_number, page_node in enumerate(json_output.children, start=1):
                page_bbox = _as_bbox(getattr(page_node, "bbox", None))
                width = None
                height = None
                if page_bbox is not None:
                    width = page_bbox.x2 - page_bbox.x1
                    height = page_bbox.y2 - page_bbox.y1

                elements: list[DocumentElement] = []
                for block in page_node.children or []:
                    elements.extend(
                        self._block_to_elements(
                            block, page_number, image_budget, warnings
                        )
                    )

                for element in elements:
                    if element.text:
                        all_text_parts.append(element.text)

                pages.append(
                    Page(
                        page_number=page_number,
                        elements=elements,
                        width=width,
                        height=height,
                    )
                )

            full_text = "\n".join(all_text_parts)
            markdown = markdown_output.markdown or ""

            processing_time_ms = int((time.perf_counter() - start) * 1000)

            return ParseResponse(
                document_id=document_id,
                status="completed",
                document=DocumentInfo(
                    mime_type="application/pdf",
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
                    processor_version=self._marker_version(),
                    processing_time_ms=processing_time_ms,
                    contract_version=CONTRACT_VERSION,
                ),
                warnings=warnings,
            )
        except Exception as exc:  # pragma: no cover - falha de infraestrutura
            logger.error(
                "erro_no_parser_marker",
                document_id=document_id,
                error_type=type(exc).__name__,
            )
            processing_time_ms = int((time.perf_counter() - start) * 1000)
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
                    processor_version=self._marker_version(),
                    processing_time_ms=processing_time_ms,
                    contract_version=CONTRACT_VERSION,
                ),
                warnings=warnings,
                error_code="MARKER_FAILED",
                error_message="Falha ao processar o documento com o Marker.",
            )

    def _block_to_elements(
        self,
        block: Any,
        page_number: int,
        image_budget: _ImageBudget | None = None,
        warnings: list[str] | None = None,
    ) -> list[DocumentElement]:
        """Converte um bloco (possivelmente container) em elementos.

        ``image_budget`` limita os bytes de imagem embutidos no documento;
        ``warnings`` recebe avisos quando um recorte é recusado (tamanho).
        """
        children = getattr(block, "children", None)
        # Containers sem HTML próprio: descemos para os filhos (preserva ordem).
        if children:
            elements: list[DocumentElement] = []
            for child in children:
                elements.extend(
                    self._block_to_elements(
                        child, page_number, image_budget, warnings
                    )
                )
            return elements

        block_type = getattr(block, "block_type", None)
        normalized_type = _normalize_type(block_type)

        html = getattr(block, "html", None)
        bbox = _as_bbox(getattr(block, "bbox", None))

        table: Table | None = None
        if normalized_type == "table":
            table = parse_table_html(html, bbox)

        if table is not None:
            text = table_to_text(table)
        else:
            text = html_to_text(html)

        element_id = str(getattr(block, "id", "")) or f"p{page_number}-block"
        section_hierarchy = getattr(block, "section_hierarchy", None)

        metadata: dict[str, Any] = {}
        if block_type:
            metadata["blockType"] = block_type
        if section_hierarchy:
            metadata["sectionHierarchy"] = section_hierarchy

        image_ref: str | None = None
        if normalized_type == "image":
            image_ref = self._image_ref_for_block(
                block, element_id, image_budget, metadata, warnings
            )

        return [
            DocumentElement(
                id=element_id,
                type=normalized_type,
                text=text or None,
                bbox=bbox,
                confidence=None,
                table=table,
                image_ref=image_ref,
                metadata=metadata,
            )
        ]

    @staticmethod
    def _image_ref_for_block(
        block: Any,
        element_id: str,
        image_budget: _ImageBudget | None,
        metadata: dict[str, Any],
        warnings: list[str] | None,
    ) -> str | None:
        """Extrai o recorte do bloco como data URL, respeitando os tetos.

        Devolve ``None`` quando a extração está desativada, o Marker não
        forneceu recorte ou o recorte excede os limites — sempre registrando o
        motivo em ``metadata`` (representação honesta, sem referência falsa).
        """
        if image_budget is None:
            metadata["imageExtracted"] = False
            metadata["imageSkippedReason"] = "disabled"
            return None

        found = _block_image_base64(block)
        if found is None:
            metadata["imageExtracted"] = False
            metadata["imageSkippedReason"] = "not_available"
            return None

        base64_data, size_bytes = found
        mime = _image_mime_type()
        metadata["imageBytes"] = size_bytes
        metadata["imageMimeType"] = mime
        if not image_budget.take(size_bytes):
            metadata["imageExtracted"] = False
            metadata["imageSkippedReason"] = "size_limit"
            if warnings is not None:
                warnings.append(
                    f"imagem do elemento {element_id} não embutida: "
                    f"{size_bytes} bytes excedem o limite configurado."
                )
            return None

        metadata["imageExtracted"] = True
        return f"data:{mime};base64,{base64_data}"

    @staticmethod
    def _marker_version() -> str:
        """Versão instalada do ``marker-pdf`` (``unknown`` se indisponível)."""
        try:
            from importlib.metadata import version

            return version("marker-pdf")
        except Exception:  # pragma: no cover
            return "unknown"


def _as_bbox(value: Any) -> BBox | None:
    """Converte uma lista/tupla [x1, y1, x2, y2] em :class:`BBox`."""
    if value is None:
        return None
    try:
        x1, y1, x2, y2 = value
        return BBox(x1=float(x1), y1=float(y1), x2=float(x2), y2=float(y2))
    except (TypeError, ValueError):
        return None
