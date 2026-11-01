"""Testes unitários da conversão de HTML do Marker (não dependem do Marker)."""

from document_intelligence.parser import html_to_text, parse_table_html, table_to_text


def test_html_to_text_paragrafo() -> None:
    html = '<p block-type="Text"><b>Tensão Nominal: </b>220 / 127 V</p>'
    assert html_to_text(html) == "Tensão Nominal: 220 / 127 V"


def test_html_to_text_lista() -> None:
    html = "<ul><li>Primeiro item</li><li>Segundo item</li></ul>"
    assert html_to_text(html) == "Primeiro item\nSegundo item"


def test_html_to_text_vazio() -> None:
    assert html_to_text(None) == ""
    assert html_to_text("") == ""


def test_parse_table_com_th() -> None:
    html = (
        "<table><tr><th>Mês/Ano</th><th>Consumo</th></tr>"
        "<tr><td>01/2025</td><td>100</td></tr>"
        "<tr><td>02/2025</td><td>200</td></tr></table>"
    )
    table = parse_table_html(html)
    assert table is not None
    assert table.headers == ["Mês/Ano", "Consumo"]
    assert table.rows == [["01/2025", "100"], ["02/2025", "200"]]
    assert len(table.cells) == 6
    assert table.cells[0].row == 0
    assert table.cells[0].column == 0


def test_parse_table_sem_th() -> None:
    html = (
        "<table><tr><td>Energia</td><td>1.201,82</td></tr>"
        "<tr><td>Água</td><td>50,00</td></tr></table>"
    )
    table = parse_table_html(html)
    assert table is not None
    assert table.headers == []
    assert table.rows == [["Energia", "1.201,82"], ["Água", "50,00"]]


def test_parse_table_com_span() -> None:
    html = (
        '<table><tr><th colspan="2">Total</th></tr>'
        '<tr><td rowspan="2">A</td><td>1</td></tr></table>'
    )
    table = parse_table_html(html)
    assert table is not None
    assert table.headers == ["Total"]
    assert table.cells[0].colspan == 2
    assert table.cells[1].rowspan == 2


def test_parse_table_html_invalido() -> None:
    assert parse_table_html("") is None
    assert parse_table_html("<p>sem tabela</p>") is None


def test_table_to_text() -> None:
    table = parse_table_html(
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
    )
    assert table is not None
    assert table_to_text(table) == "A | B\n1 | 2"
