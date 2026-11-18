"""Gera os arquivos de valores esperados (ground truth) a partir da lógica
determinística de geração de fixtures.

É executado após generate_fixtures.py. Produz um JSON por fixture em
fixtures/expected/<id>.json com os valores exatos que o OCR deve conseguir
extrair, para uso pelo harness de avaliação.
"""

from __future__ import annotations

import json
import os

# Importa as funções de geração do pacote de fixtures.
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../documents")

from generate_fixtures import (  # noqa: E402
    SEED,
    titular,
    consumo_energia,
    consumo_agua,
    datas,
    emissores,
    LAYOUTS_ENERGIA,
    LAYOUTS_AGUA,
    FIXTURES,
    random,
)

ROOT = os.path.dirname(os.path.abspath(__file__))
EXPECTED_DIR = ROOT


def expected_for(i, tipo, em_idx, layout_idx, modo):
    emissor = emissores()[em_idx]
    rng = random.Random(SEED + i * 1000 + (em_idx * 100 + layout_idx * 10))
    holder = titular(emissor, rng)
    cons = consumo_energia(rng) if tipo == "energia" else consumo_agua(rng)
    dat = datas(rng)

    base = {
        "id": FIXTURES[i][0].replace(".pdf", ""),
        "tipo": tipo,
        "emissor": emissor.nome,
        "uf": emissor.uf,
        "cidade": emissor.cidade,
        "versao_layout": emissor.layout_version,
        "arquivo": FIXTURES[i][0],
        "titular": holder.nome,
        "cpf": holder.cpf,
        "endereco": holder.endereco,
        "cep": holder.cep,
        "cidade_titular": holder.cidade,
        "uf_titular": holder.uf,
        "instalacao": holder.instalacao,
        "codigo_cliente": holder.codigo_cliente,
        "data_emissao": dat["emissao"],
        "data_vencimento": dat["vencimento"],
        "referencia": dat["referencia"],
    }
    if tipo == "energia":
        base.update({
            "consumo_kwh": cons["consumo_kwh"],
            "valor_energia": cons["valor_energia"],
            "tarifa": cons["tarifa"],
            "leitura_anterior": cons["leitura_anterior"],
            "leitura_atual": cons["leitura_atual"],
        })
    else:
        base.update({
            "consumo_m3": cons["consumo_m3"],
            "valor_agua": cons["valor_agua"],
            "tarifa": cons["tarifa"],
            "leitura_anterior": cons["leitura_anterior"],
            "leitura_atual": cons["leitura_atual"],
        })
    return base


def main():
    os.makedirs(EXPECTED_DIR, exist_ok=True)
    for i, (rel, tipo, em_idx, layout_idx, modo) in enumerate(FIXTURES):
        doc_id = os.path.basename(rel).replace(".pdf", "")
        dados = expected_for(i, tipo, em_idx, layout_idx, modo)
        out = os.path.join(EXPECTED_DIR, f"{doc_id}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False, indent=2)
        print(f"[ok] {out}")


if __name__ == "__main__":
    main()
