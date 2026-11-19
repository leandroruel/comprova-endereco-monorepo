"""Harness de avaliação de extração sobre as fixtures sintéticas.

Executa o pipeline real de processamento (``build_parse_response``) sobre cada
PDF de fixture, extrai os campos do texto reconhecido por OCR/camada de texto e
compara contra os valores esperados em ``fixtures/expected/``.

Gera um relatório JSON com a taxa de acerto por campo e por documento, útil
para medir regressões na extração à medida que o pipeline OCR evolui.

Não modifica o serviço OCR, apenas consome o contrato público
(``build_parse_response``).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

from document_intelligence.pdf_processor import build_parse_response

# Raiz da pasta de fixtures (ajustado conforme local deste arquivo).
FIXTURES_ROOT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "fixtures"
)
MANIFESTS_DIR = os.path.join(FIXTURES_ROOT, "manifests")
# O campo "arquivo" dos manifestos já é relativo à raiz fixtures/ (inclui
# "documents/"), então DOCUMENTS_DIR aponta para a raiz fixtures/.
DOCUMENTS_DIR = FIXTURES_ROOT
EXPECTED_DIR = os.path.join(FIXTURES_ROOT, "expected")
REPORT_PATH = os.path.join(FIXTURES_ROOT, "evaluation_report.json")
_RE_CPF = re.compile(r"\d{3}\.\d{3}\.\d{3}-\d{2}")
_RE_CNPJ = re.compile(r"\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}")
_RE_CEP = re.compile(r"\d{5}-\d{3}")
# Data seguida do rótulo Emissão (ex: "Emissão: 10/05/2025").
_RE_DATA_EMISSAO = re.compile(r"emissão\s*[:.]\s*(\d{2}/\d{2}/\d{4})", re.IGNORECASE)
# Data seguida do rótulo Vencimento (ex: "Vencimento: 20/05/2025").
_RE_DATA_VENCIMENTO = re.compile(r"vencimento\s*[:.]\s*(\d{2}/\d{2}/\d{4})", re.IGNORECASE)
# Valor monetário precedido por rótulo específico (ex: "Valor da água: R$ 213,99").
# Aceita tanto "agua" quanto "água".
# Usa \\x24 em vez de \\$ para evitar problemas de escape em alguns engines de regex.
_RE_VALOR_LABEL = re.compile(
    r"(?:valor\s*(?:da\s*energia|da\s*água|da\s*agua|total|a\s*pagar)?\s*[:.]\s*)([Rr]\x24\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?)",
    re.IGNORECASE,
)
_RE_KWH = re.compile(r"consumo\s*[:.]\s*(\d{2,4})\s*kWh", re.IGNORECASE)
# m³ aceita superscript (m³) ou ASCII normalizado (m3).
_RE_M3 = re.compile(r"consumo\s*[:.]\s*(\d{1,4})\s*m³?", re.IGNORECASE)


def _carregar_json(caminho: str) -> dict:
    with open(caminho, "r", encoding="utf-8") as f:
        return json.load(f)


def _listar_manifestos() -> list[dict]:
    manifestos = []
    if not os.path.isdir(MANIFESTS_DIR):
        return manifestos
    for nome in sorted(os.listdir(MANIFESTS_DIR)):
        if nome.endswith(".json"):
            manifestos.append(_carregar_json(os.path.join(MANIFESTS_DIR, nome)))
    return manifestos


def _extrair_campo(texto: str, campo: str) -> str | None:
    """Extrai um campo do texto reconhecido usando heurísticas de padrão."""
    t = texto
    tl = t.lower()

    if campo == "cpf":
        m = _RE_CPF.search(t)
        return m.group(0) if m else None
    if campo == "cep":
        m = _RE_CEP.search(t)
        return m.group(0) if m else None
    if campo == "data_emissao":
        # Identifica apenas pelo rótulo "Emissão", nunca por ordem de ocorrência.
        m = _RE_DATA_EMISSAO.search(tl)
        return m.group(1) if m else None
    if campo == "data_vencimento":
        # Identifica apenas pelo rótulo "Vencimento", nunca por ordem de ocorrência.
        m = _RE_DATA_VENCIMENTO.search(tl)
        return m.group(1) if m else None
    if campo in ("valor_energia", "valor_agua"):
        # Identifica apenas pelo rótulo semântico correspondente.
        # Não faz fallback para o primeiro valor monetário encontrado, pois
        # esse pode ser tarifa, imposto, multa ou outro componente.
        # Usa \\x24 em vez de \\$ para evitar problemas de escape em regex.
        # Usa \\s+ entre palavras do rótulo (em vez de re.escape, que escapa
        # espaços e impede a correspondência).
        # Aceita tanto "agua" quanto "água" no rótulo.
        if campo == "valor_energia":
            label_pattern = r"valor\s+da\s+energia"
        else:
            label_pattern = r"valor\s+da\s*[áa]gua"
        pattern = re.compile(
            rf"(?:{label_pattern})\s*[:.]\s*([Rr]\x24\s*\d{{1,3}}(?:\.\d{{3}})*(?:,\d{{2}}))?",
            re.IGNORECASE,
        )
        m = pattern.search(tl)
        if m:
            valor = m.group(1)
            # Normaliza para "R$" maiúsculo, pois o texto pode vir em minúsculo.
            return valor[0].upper() + valor[1:]
        return None
    if campo == "consumo_kwh":
        m = _RE_KWH.search(tl)
        return m.group(1) if m else None
    if campo == "consumo_m3":
        m = _RE_M3.search(tl)
        return m.group(1) if m else None
    if campo == "referencia":
        # Busca após label "Ref:" ou "Referência:".
        m = re.search(r"(?:ref(?:erência)?)\s*[:.]\s*(\d{2}/\d{4})", tl)
        return m.group(1) if m else None

    # Campos por rótulo: busca a linha que contém o rótulo como palavra
    # completa (word boundary), evitando corresponder a substrings dentro de
    # nomes (ex: "uf" dentro de "Rufino").
    rotulos = {
        "titular": ["titular", "nome"],
        "endereco": ["endereço", "endereco"],
        "instalacao": ["instalação", "instalacao", "matrícula", "matricula"],
        "codigo_cliente": ["código do cliente", "codigo do cliente"],
        "cidade": ["cidade"],
        "uf": ["uf"],
    }
    if campo in rotulos:
        rotulos_conhecidos = set()
        for rots in rotulos.values():
            rotulos_conhecidos.update(rots)
        # Adiciona labels de outros campos para delimitar o restante.
        rotulos_conhecidos.update(
            ["cpf", "endereço", "endereco", "cep", "cidade", "uf",
             "instalação", "instalacao", "matrícula", "matricula",
             "código do cliente", "codigo do cliente", "emissão", "vencimento",
             "ref:", "referência:", "consumo", "leitura anterior", "leitura atual",
             "valor da energia", "valor da agua", "tarifa"]
        )
        # Compila regex com word boundary para cada rótulo do campo.
        rotulo_regexes = [
            re.compile(r"\b" + re.escape(rot) + r"\b", re.IGNORECASE)
            for rot in rotulos[campo]
        ]
        linhas = t.splitlines()
        for i, linha in enumerate(linhas):
            l = linha.lower()
            # Verifica se algum rótulo aparece como palavra completa na linha.
            if not any(rx.search(l) for rx in rotulo_regexes):
                continue
            # Remove o rótulo e pontuação, devolve o restante da linha.
            restante = linha
            for rx in rotulo_regexes:
                restante = rx.sub("", restante, count=1)
            restante = restante.strip(" :\t-|")
            if not restante:
                # Rótulo está sozinho na linha; tenta pegar o valor na próxima linha.
                if i + 1 < len(linhas):
                    proxima = linhas[i + 1].strip(" :\t-|")
                    # Não aceita se a próxima linha também começa com um rótulo conhecido.
                    proxima_lower = proxima.lower()
                    if any(
                        re.compile(r"\b" + re.escape(rot) + r"\b", re.IGNORECASE).search(proxima_lower)
                        for rot in rotulos_conhecidos
                    ):
                        continue
                    return proxima
                continue
            # Se houver outro rótulo conhecido na mesma linha, corta.
            for rot_conhecido in rotulos_conhecidos:
                # Rótulos conhecidos também usam word boundary.
                rx_conhecido = re.compile(r"\b" + re.escape(rot_conhecido) + r"\b", re.IGNORECASE)
                m = rx_conhecido.search(restante.lower())
                if m:
                    restante = restante[:m.start()].strip(" :\t-|")
                    break
            if restante:
                return restante
    return None


@dataclass
class ResultadoCampo:
    campo: str
    esperado: str | None
    extraido: str | None
    correto: bool


@dataclass
class ResultadoDocumento:
    id: str
    arquivo: str
    tipo: str
    uf: str
    qualidade: str
    status: str
    chars_extraidos: int
    campos: list[ResultadoCampo] = field(default_factory=list)

    @property
    def acertos(self) -> int:
        return sum(1 for c in self.campos if c.correto)

    @property
    def total(self) -> int:
        return len(self.campos)

    @property
    def taxa_acerto(self) -> float:
        if not self.total:
            return 0.0
        return self.acertos / self.total


@dataclass
class RelatorioAvaliacao:
    total_documentos: int = 0
    documentos_com_sucesso: int = 0
    media_taxa_acerto: float = 0.0
    por_campo: dict[str, dict[str, int]] = field(default_factory=dict)
    documentos: list[ResultadoDocumento] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_documentos": self.total_documentos,
            "documentos_com_sucesso": self.documentos_com_sucesso,
            "media_taxa_acerto": round(self.media_taxa_acerto, 4),
            "por_campo": self.por_campo,
            "documentos": [
                {
                    "id": d.id,
                    "arquivo": d.arquivo,
                    "tipo": d.tipo,
                    "uf": d.uf,
                    "qualidade": d.qualidade,
                    "status": d.status,
                    "chars_extraidos": d.chars_extraidos,
                    "taxa_acerto": round(d.taxa_acerto, 4),
                    "acertos": d.acertos,
                    "total": d.total,
                    "campos": [
                        {
                            "campo": c.campo,
                            "esperado": c.esperado,
                            "extraido": c.extraido,
                            "correto": c.correto,
                        }
                        for c in d.campos
                    ],
                }
                for d in self.documentos
            ],
        }


def avaliar_documento(manifest: dict) -> ResultadoDocumento:
    """Avalia um único documento contra o seu valor esperado."""
    doc_id = manifest["id"]
    arquivo = manifest["arquivo"]
    caminho_pdf = os.path.join(DOCUMENTS_DIR, arquivo)
    caminho_esperado = os.path.join(EXPECTED_DIR, f"{doc_id.replace('/', '-')}.json")

    esperado = _carregar_json(caminho_esperado) if os.path.exists(caminho_esperado) else {}

    response = build_parse_response(caminho_pdf, doc_id, size_bytes=os.path.getsize(caminho_pdf))
    texto = response.content.get("text", "")

    campos_esperados = manifest.get("campos_esperados", [])
    resultados: list[ResultadoCampo] = []
    for campo in campos_esperados:
        valor_esperado = esperado.get(campo)
        extraido = _extrair_campo(texto, campo) if valor_esperado is not None else None
        correto = (
            extraido is not None
            and valor_esperado is not None
            and extraido.replace(" ", "").lower() == valor_esperado.replace(" ", "").lower()
        )
        resultados.append(ResultadoCampo(
            campo=campo,
            esperado=valor_esperado,
            extraido=extraido,
            correto=correto,
        ))

    return ResultadoDocumento(
        id=doc_id,
        arquivo=arquivo,
        tipo=manifest.get("tipo", ""),
        uf=manifest.get("uf", ""),
        qualidade=manifest.get("qualidade", ""),
        status=response.status,
        chars_extraidos=len(texto),
        campos=resultados,
    )


def executar_avaliacao() -> RelatorioAvaliacao:
    """Executa a avaliação sobre todos os manifestos e devolve o relatório."""
    manifestos = _listar_manifestos()
    rel = RelatorioAvaliacao()
    rel.total_documentos = len(manifestos)

    totais_campo: dict[str, dict[str, int]] = {}

    for m in manifestos:
        res = avaliar_documento(m)
        rel.documentos.append(res)
        if res.status == "completed":
            rel.documentos_com_sucesso += 1
        for c in res.campos:
            agg = totais_campo.setdefault(c.campo, {"total": 0, "acertos": 0})
            agg["total"] += 1
            if c.correto:
                agg["acertos"] += 1

    for campo, agg in totais_campo.items():
        rel.por_campo[campo] = {
            "total": agg["total"],
            "acertos": agg["acertos"],
            "taxa_acerto": round(agg["acertos"] / agg["total"], 4) if agg["total"] else 0.0,
        }

    if rel.documentos:
        rel.media_taxa_acerto = sum(d.taxa_acerto for d in rel.documentos) / len(rel.documentos)

    return rel


def salvar_relatorio(rel: RelatorioAvaliacao, caminho: str = REPORT_PATH) -> None:
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(rel.to_dict(), f, ensure_ascii=False, indent=2)
