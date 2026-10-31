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
# Extração de texto e tabelas a partir do HTML do Marker.
# ---------------------------------------------------------------------------
_WS_RE = re.compile(r"[ \t\r\f\v]+")


def _normalize_text(text: str) -> str:
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
        return self._loaded

    @property
    def warm(self) -> bool:
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
                self.parse(path, "warmup", size_bytes=0)
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
            if settings.max_pages is not None and page_count > settings.max_pages:
                warnings.append(
                    f"PDF tem {page_count} páginas; o limite configurado é "
                    f"{settings.max_pages}. O processamento pode ter sido limitado."
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
                    elements.extend(self._block_to_elements(block, page_number))

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
        self, block: Any, page_number: int
    ) -> list[DocumentElement]:
        """Converte um bloco (possivelmente container) em elementos."""
        children = getattr(block, "children", None)
        # Containers sem HTML próprio: descemos para os filhos (preserva ordem).
        if children:
            elements: list[DocumentElement] = []
            for child in children:
                elements.extend(self._block_to_elements(child, page_number))
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

        return [
            DocumentElement(
                id=element_id,
                type=normalized_type,
                text=text or None,
                bbox=bbox,
                confidence=None,
                table=table,
                metadata={
                    "block_type": block_type,
                    "section_hierarchy": section_hierarchy or {},
                }
                if block_type or section_hierarchy
                else {},
            )
        ]

    @staticmethod
    def _marker_version() -> str:
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
