"""Contrato JSON de saída do serviço Document Intelligence.

O contrato é independente da estrutura interna do Marker e versionado pelo
campo ``contractVersion``. Todos os campos são opcionais quando não se
aplicam, mas o objetivo é preservar páginas, ordem dos elementos e
coordenadas quando disponíveis.

Versão atual do contrato: ``1.0``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, alias_generators


class CamelModel(BaseModel):
    """Base com aliases camelCase no JSON (Python continua em snake_case)."""

    model_config = ConfigDict(
        frozen=True,
        alias_generator=alias_generators.to_camel,
        populate_by_name=True,
    )


class BBox(CamelModel):
    """Coordenadas de bounding box de um elemento (em pontos do PDF)."""

    x1: float
    y1: float
    x2: float
    y2: float


class TableCell(CamelModel):
    """Célula de uma tabela."""

    text: str
    row: int
    column: int
    rowspan: int = 1
    colspan: int = 1


class Table(CamelModel):
    """Representação estruturada de uma tabela."""

    headers: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    cells: list[TableCell] = Field(default_factory=list)
    bbox: BBox | None = None


class ElementType(str):
    """Tipos de elemento reconhecidos pelo serviço."""

    HEADING = "heading"
    TEXT = "text"
    TABLE = "table"
    IMAGE = "image"
    LIST = "list"
    LIST_ITEM = "list_item"
    PAGE_HEADER = "page_header"
    PAGE_FOOTER = "page_footer"
    CODE_BLOCK = "code_block"
    FORMULA = "formula"
    CAPTION = "caption"
    UNKNOWN = "unknown"


class DocumentElement(CamelModel):
    """Elemento estrutural de uma página."""

    id: str
    type: str
    text: str | None = None
    bbox: BBox | None = None
    confidence: float | None = None
    table: Table | None = None
    image_ref: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Page(CamelModel):
    """Uma página do documento."""

    page_number: int
    elements: list[DocumentElement] = Field(default_factory=list)
    width: float | None = None
    height: float | None = None


class DocumentInfo(CamelModel):
    """Metadados do documento processado."""

    mime_type: str
    page_count: int
    size_bytes: int


class ProcessingMetadata(CamelModel):
    """Metadados do processamento."""

    processor: str = "marker"
    processor_version: str
    processing_time_ms: int
    contract_version: str = "1.0"


class ParseResponse(CamelModel):
    """Resposta do endpoint ``POST /documents/parse``."""

    document_id: str
    status: Literal["completed", "failed"]
    document: DocumentInfo
    content: dict[str, Any] = Field(
        default_factory=dict,
        description="Conteúdo extraído (texto completo, markdown, etc.)",
    )
    pages: list[Page] = Field(default_factory=list)
    metadata: ProcessingMetadata
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None


class HealthResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: Literal["ok", "degraded"]
    service: str = "document-intelligence"
    version: str = "0.1.0"
    marker_available: bool = False


class ReadyResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: Literal["ready", "not_ready"]
    service: str = "document-intelligence"
    version: str = "0.1.0"
    models_loaded: bool = False
    checks: dict[str, str] = Field(default_factory=dict)
