"""Testes de avaliação sobre as fixtures sintéticas de documentos.

Executa o harness de extração sobre todos os manifestos e valida:
1. Todo manifesto tem um PDF correspondente.
2. Todo manifesto tem um arquivo de valores esperados correspondente.
3. O pipeline processa todos os PDFs com status "completed".
4. Relatório de avaliação é gerado com taxa de acerto por campo.

Esses testes exercitam o pipeline OCR real (Tesseract) e são marcados como
``integration``. Rode apenas com::

    pytest -m integration

Não modificam o serviço OCR nem os documentos sintéticos.
"""

from __future__ import annotations

import json
import os

import pytest

from document_intelligence.tests.extraction.harness import (
    DOCUMENTS_DIR,
    EXPECTED_DIR,
    MANIFESTS_DIR,
    executar_avaliacao,
    salvar_relatorio,
    _carregar_json,
    _listar_manifestos,
)

pytestmark = [pytest.mark.integration]


def _manifestos() -> list[dict]:
    return _listar_manifestos()


# ---------------------------------------------------------------------------
# Validação automática dos manifestos
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("manifest", _manifestos(), ids=lambda m: m["id"])
def test_manifesto_tem_pdf(manifest: dict) -> None:
    """Todo manifesto aponta para um PDF existente."""
    caminho = os.path.join(DOCUMENTS_DIR, manifest["arquivo"])
    assert os.path.isfile(caminho), f"PDF não encontrado: {caminho}"


@pytest.mark.parametrize("manifest", _manifestos(), ids=lambda m: m["id"])
def test_manifesto_tem_esperado(manifest: dict) -> None:
    """Todo manifesto tem um arquivo de valores esperado."""
    doc_id = manifest["id"].replace("/", "-")
    caminho = os.path.join(EXPECTED_DIR, f"{doc_id}.json")
    assert os.path.isfile(caminho), f"Esperado não encontrado: {caminho}"


@pytest.mark.parametrize("manifest", _manifestos(), ids=lambda m: m["id"])
def test_manifesto_tem_campos_esperados(manifest: dict) -> None:
    """Todo manifesto declara ao menos um campo esperado."""
    assert manifest.get("campos_esperados"), f"Sem campos_esperados em {manifest['id']}"


# ---------------------------------------------------------------------------
# Avaliação de extração
# ---------------------------------------------------------------------------

def test_todos_documentos_processam_com_sucesso() -> None:
    """Todos os PDFs das fixtures processam com status completed."""
    manifestos = _manifestos()
    assert manifestos, "Nenhum manifesto encontrado"
    for m in manifestos:
        from document_intelligence.pdf_processor import build_parse_response

        caminho = os.path.join(DOCUMENTS_DIR, m["arquivo"])
        response = build_parse_response(caminho, m["id"], size_bytes=os.path.getsize(caminho))
        assert response.status == "completed", f"{m['id']} falhou: {response.status}"
        assert response.document.page_count >= 1


def test_geracao_relatorio_avaliacao(tmp_path) -> None:
    """Executa o harness e gera o relatório de avaliação com validações fortes."""
    rel = executar_avaliacao()
    caminho_relatorio = tmp_path / "evaluation_report.json"
    salvar_relatorio(rel, caminho=str(caminho_relatorio))

    manifestos = _manifestos()
    assert rel.total_documentos == len(manifestos)
    assert rel.documentos_com_sucesso == len(manifestos)

    # Todo documento deve ter ao menos um campo esperado avaliado.
    for d in rel.documentos:
        assert d.total > 0, f"{d.id} sem campos avaliados"

    # Relatório salvo em disco temporário.
    assert caminho_relatorio.exists()

    # Valida o cálculo da taxa média de acerto.
    total_campos = sum(d.total for d in rel.documentos)
    total_acertos = sum(d.acertos for d in rel.documentos)
    taxa_esperada = round(total_acertos / total_campos, 4) if total_campos else 0.0
    taxa_documentos_esperada = (
        round(sum(d.taxa_acerto for d in rel.documentos) / len(rel.documentos), 4)
        if rel.documentos else 0.0
    )
    assert round(rel.media_taxa_acerto, 4) == taxa_documentos_esperada

    # Valida consistência entre por_campo e resultados individuais.
    for campo, agg in rel.por_campo.items():
        assert agg["total"] > 0
        assert agg["acertos"] <= agg["total"]
        assert agg["taxa_acerto"] == round(agg["acertos"] / agg["total"], 4)

    # Valida que todo campo esperado tem correspondência entre esperado e extraído.
    for d in rel.documentos:
        for c in d.campos:
            if c.correto:
                assert c.extraido is not None
                assert c.esperado is not None
                assert c.extraido.replace(" ", "").lower() == c.esperado.replace(" ", "").lower()
            else:
                # Se não está correto, ou extraído é None ou diferem.
                if c.extraido is not None and c.esperado is not None:
                    assert c.extraido.replace(" ", "").lower() != c.esperado.replace(" ", "").lower()

    print("\n=== RELATÓRIO DE AVALIAÇÃO ===")
    print(f"Documentos: {rel.documentos_com_sucesso}/{rel.total_documentos}")
    print(f"Total de campos avaliados: {total_campos}")
    print(f"Total de acertos: {total_acertos}")
    print(f"Taxa média de acerto: {rel.media_taxa_acerto:.2%}")
    for campo, agg in rel.por_campo.items():
        print(f"  {campo}: {agg['acertos']}/{agg['total']} = {agg['taxa_acerto']:.0%}")


# ---------------------------------------------------------------------------
# Testes específicos de extração de campos (harness)
# ---------------------------------------------------------------------------

from document_intelligence.tests.extraction.harness import _extrair_campo  # noqa: E402


def test_extrair_titular_nome_com_uf_dentro():
    """Titular com nome contendo sequência que parece rótulo 'uf' (ex: 'Rufino')."""
    texto = "Titular: Ana Rufino"
    assert _extrair_campo(texto, "titular") == "Ana Rufino"


def test_extrair_titular_nome_com_cpf_apos():
    """Titular seguido de CPF na mesma linha."""
    texto = "Titular: Ana Rufino CPF: 123.456.789-00"
    assert _extrair_campo(texto, "titular") == "Ana Rufino"


def test_extrair_titular_nome_com_endereco_apos():
    """Titular seguido de endereço na mesma linha."""
    texto = "Titular: João da Silva Endereço: Rua X, 100"
    assert _extrair_campo(texto, "titular") == "João da Silva"


def test_extrair_titular_linha_seguinte():
    """Titular com rótulo em uma linha e valor na linha seguinte."""
    texto = "Titular:\nJuliana Beatriz Lima"
    assert _extrair_campo(texto, "titular") == "Juliana Beatriz Lima"


def test_extrair_valor_agua_com_acento():
    """Valor da água com rótulo usando 'água' (com acento)."""
    texto = "Tarifa: R$ 4,35\nValor da água: R$ 213,99"
    assert _extrair_campo(texto, "valor_agua") == "R$ 213,99"


def test_extrair_valor_agua_sem_acento():
    """Valor da água com rótulo usando 'agua' (sem acento)."""
    texto = "Tarifa: R$ 4,35\nValor da agua: R$ 213,99"
    assert _extrair_campo(texto, "valor_agua") == "R$ 213,99"


def test_extrair_valor_agua_ignora_tarifa():
    """Valor da água ignora a tarifa que aparece antes."""
    texto = "Tarifa: R$ 4,35\nValor da água: R$ 213,99"
    resultado = _extrair_campo(texto, "valor_agua")
    assert resultado == "R$ 213,99"
    assert resultado != "R$ 4,35"


# ---------------------------------------------------------------------------
# Testes de extração de cidade/UF
# ---------------------------------------------------------------------------


def test_extrair_cidade_uf_sao_paulo_sp():
    """Cidade e UF extraídas de 'São Paulo/SP'."""
    texto = "São Paulo/SP  CEP 01000-000"
    assert _extrair_campo(texto, "cidade") == "São Paulo"
    assert _extrair_campo(texto, "uf") == "SP"


def test_extrair_cidade_uf_belo_horizonte_mg():
    """Cidade e UF extraídas de 'Belo Horizonte/MG'."""
    texto = "Belo Horizonte/MG CEP 30000-000"
    assert _extrair_campo(texto, "cidade") == "Belo Horizonte"
    assert _extrair_campo(texto, "uf") == "MG"


def test_extrair_cidade_uf_vitoria_es():
    """Cidade e UF extraídas de 'Vitória/ES'."""
    texto = "Vitória/ES CEP 29000-000"
    assert _extrair_campo(texto, "cidade") == "Vitória"
    assert _extrair_campo(texto, "uf") == "ES"


def test_extrair_cidade_uf_espacos_ao_redor_da_barra():
    """Cidade e UF extraídas mesmo com espaços ao redor da barra."""
    texto = "São Paulo  /  SP"
    assert _extrair_campo(texto, "cidade") == "São Paulo"
    assert _extrair_campo(texto, "uf") == "SP"


def test_extrair_cidade_uf_sem_barra_nao_extrai():
    """Sem a barra, não há match para cidade/UF."""
    texto = "São Paulo SP"
    assert _extrair_campo(texto, "cidade") is None
    assert _extrair_campo(texto, "uf") is None


# ---------------------------------------------------------------------------
# Testes de valor monetário sem valor
# ---------------------------------------------------------------------------


def test_extrair_valor_agua_sem_valor():
    """Rótulo 'Valor da água:' sem valor deve retornar None."""
    texto = "Tarifa: R$ 4,35\nValor da água:"
    assert _extrair_campo(texto, "valor_agua") is None


def test_extrair_valor_agua_sem_valor_sem_acento():
    """Rótulo 'Valor da agua:' sem valor deve retornar None."""
    texto = "Tarifa: R$ 4,35\nValor da agua:"
    assert _extrair_campo(texto, "valor_agua") is None


def test_extrair_valor_energia_sem_valor():
    """Rótulo 'Valor da energia:' sem valor deve retornar None."""
    texto = "Tarifa: R$ 4,35\nValor da energia:"
    assert _extrair_campo(texto, "valor_energia") is None


def test_extrair_valor_texto_que_nao_eh_valor_monetario():
    """Rótulo seguido de texto que não é valor monetário deve retornar None."""
    texto = "Valor da água: não informado"
    assert _extrair_campo(texto, "valor_agua") is None


def test_extrair_valor_valido_continua_funcionando():
    """Valor válido continua sendo extraído normalmente."""
    texto = "Tarifa: R$ 4,35\nValor da água: R$ 213,99"
    assert _extrair_campo(texto, "valor_agua") == "R$ 213,99"


def test_extrair_valor_agua_ignora_tarifa_antes():
    """Uma tarifa anterior ao valor total não deve ser confundida com o valor da água."""
    texto = "Tarifa: R$ 4,35\nValor da água: R$ 213,99"
    resultado = _extrair_campo(texto, "valor_agua")
    assert resultado == "R$ 213,99"
    assert resultado != "R$ 4,35"
