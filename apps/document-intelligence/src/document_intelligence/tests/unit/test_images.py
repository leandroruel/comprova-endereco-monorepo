"""Testes unitários da extração de imagens (sem carregar modelos do Marker)."""

from __future__ import annotations

import base64
import io
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from document_intelligence.parser import (
    MarkerParser,
    _ImageBudget,
    _block_image_base64,
)


def _jpeg_base64(size: tuple[int, int] = (40, 40)) -> tuple[str, int]:
    """Gera um JPEG pequeno e devolve ``(base64, tamanho_em_bytes)``."""
    buffer = io.BytesIO()
    Image.new("RGB", size, "black").save(buffer, format="JPEG")
    raw = buffer.getvalue()
    return base64.b64encode(raw).decode(), len(raw)


def _picture(
    base64_data: str,
    block_id: str = "/page/0/Picture/1",
    block_type: str = "Picture",
    **extra: Any,
) -> SimpleNamespace:
    """Bloco equivalente ao ``JSONBlockOutput`` produzido pelo Marker."""
    data: dict[str, Any] = {
        "id": block_id,
        "block_type": block_type,
        "html": None,
        "bbox": [10.0, 20.0, 110.0, 120.0],
        "children": None,
        "section_hierarchy": None,
        "images": {block_id: base64_data},
    }
    data.update(extra)
    return SimpleNamespace(**data)


def _budget(
    max_per_image: int = 262_144, max_total: int = 2_097_152
) -> _ImageBudget:
    return _ImageBudget(max_per_image=max_per_image, max_total=max_total)


def test_imagem_extraida_preserva_pagina_bbox_e_referencia() -> None:
    """Recorte vira data URL válida mantendo página e bounding box."""
    base64_data, size = _jpeg_base64()
    block = _picture(base64_data)
    warnings: list[str] = []

    elements = MarkerParser()._block_to_elements(block, 1, _budget(), warnings)

    assert len(elements) == 1
    element = elements[0]
    assert element.type == "image"
    assert element.id == "/page/0/Picture/1"
    assert element.bbox is not None
    assert (element.bbox.x1, element.bbox.y1, element.bbox.x2, element.bbox.y2) == (
        10.0,
        20.0,
        110.0,
        120.0,
    )
    assert element.image_ref is not None
    assert element.image_ref.startswith("data:image/jpeg;base64,")
    assert element.metadata["imageExtracted"] is True
    assert element.metadata["imageBytes"] == size
    assert element.metadata["imageMimeType"] == "image/jpeg"
    assert warnings == []

    # A imagem pode ser recuperada a partir da referência.
    raw = base64.b64decode(element.image_ref.split(",", 1)[1])
    with Image.open(io.BytesIO(raw)) as recovered:
        assert recovered.size == (40, 40)


def test_imagem_acima_do_limite_individual_nao_e_inventada() -> None:
    """Acima do teto: sem ``imageRef``, motivo explícito e warning."""
    base64_data, _ = _jpeg_base64()
    warnings: list[str] = []

    elements = MarkerParser()._block_to_elements(
        _picture(base64_data), 1, _budget(max_per_image=10), warnings
    )

    element = elements[0]
    assert element.type == "image"
    assert element.bbox is not None
    assert element.image_ref is None
    assert element.metadata["imageExtracted"] is False
    assert element.metadata["imageSkippedReason"] == "size_limit"
    assert len(warnings) == 1
    assert "/page/0/Picture/1" in warnings[0]


def test_orcamento_total_por_documento() -> None:
    """O teto total vale para o documento: a segunda imagem é recusada."""
    first_b64, size = _jpeg_base64()
    second_b64, _ = _jpeg_base64((80, 80))
    budget = _budget(max_per_image=size * 10, max_total=size)
    parser = MarkerParser()
    warnings: list[str] = []

    first = parser._block_to_elements(_picture(first_b64), 1, budget, warnings)[0]
    second = parser._block_to_elements(
        _picture(second_b64, block_id="/page/0/Picture/2"), 1, budget, warnings
    )[0]

    assert first.image_ref is not None
    assert second.image_ref is None
    assert second.metadata["imageSkippedReason"] == "size_limit"


def test_extracao_desativada_e_representada() -> None:
    """Com ``include_images=False`` não há referência nem warning."""
    base64_data, _ = _jpeg_base64()
    warnings: list[str] = []

    elements = MarkerParser()._block_to_elements(
        _picture(base64_data), 1, None, warnings
    )

    element = elements[0]
    assert element.image_ref is None
    assert element.metadata["imageExtracted"] is False
    assert element.metadata["imageSkippedReason"] == "disabled"
    assert warnings == []


def test_bloco_sem_recorte_nao_ganha_referencia_falsa() -> None:
    """Tipos de imagem sem recorte do Marker ficam honestamente sem ref."""
    block = _picture("", images={})
    elements = MarkerParser()._block_to_elements(block, 1, _budget(), [])

    element = elements[0]
    assert element.type == "image"
    assert element.image_ref is None
    assert element.metadata["imageExtracted"] is False
    assert element.metadata["imageSkippedReason"] == "not_available"


def test_chaves_de_imagem_nao_string_sao_normalizadas() -> None:
    """O Marker usa ``BlockId`` como chave; ``str()`` faz o match."""

    class _BlockId:
        def __init__(self, value: str) -> None:
            self._value = value

        def __str__(self) -> str:
            return self._value

    base64_data, _ = _jpeg_base64()
    block = _picture(base64_data)
    block.images = {_BlockId("/page/0/Picture/1"): base64_data}

    found = _block_image_base64(block)
    assert found is not None
    assert found[0] == base64_data


def test_container_propaga_orcamento_para_filhos() -> None:
    """``FigureGroup`` (container) delega a extração ao filho Picture."""
    base64_data, _ = _jpeg_base64()
    picture = _picture(base64_data)
    container = SimpleNamespace(
        id="/page/0/FigureGroup/0",
        block_type="FigureGroup",
        html=None,
        bbox=[0, 0, 200, 200],
        children=[picture],
        section_hierarchy=None,
        images={},
    )
    warnings: list[str] = []

    elements = MarkerParser()._block_to_elements(
        container, 1, _budget(), warnings
    )

    assert len(elements) == 1
    assert elements[0].id == "/page/0/Picture/1"
    assert elements[0].image_ref is not None
    assert warnings == []


def test_texto_continua_sem_image_ref() -> None:
    """Elementos não gráficos nunca recebem ``imageRef`` nem metadata de imagem."""
    block = SimpleNamespace(
        id="/page/0/Text/1",
        block_type="Text",
        html="<p>Texto</p>",
        bbox=[0.0, 0.0, 10.0, 10.0],
        children=None,
        section_hierarchy=None,
        images={},
    )

    element = MarkerParser()._block_to_elements(block, 1, _budget(), [])[0]

    assert element.type == "text"
    assert element.image_ref is None
    assert "imageExtracted" not in element.metadata
