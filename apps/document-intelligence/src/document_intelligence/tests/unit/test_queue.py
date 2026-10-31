"""Testes unitários da fila de concorrência (não dependem do Marker)."""

import asyncio

import pytest

from document_intelligence.queue import ProcessingQueue


@pytest.mark.asyncio
async def test_limite_de_concorrencia() -> None:
    fila = ProcessingQueue(max_concurrency=2)
    slots_em_uso = 0
    maximo_observado = 0

    async def trabalho() -> None:
        nonlocal slots_em_uso, maximo_observado
        async with fila:
            slots_em_uso += 1
            maximo_observado = max(maximo_observado, slots_em_uso)
            await asyncio.sleep(0.05)
            slots_em_uso -= 1

    await asyncio.gather(*(trabalho() for _ in range(10)))
    assert maximo_observado == 2


@pytest.mark.asyncio
async def test_fila_libera_slot_apos_erro() -> None:
    fila = ProcessingQueue(max_concurrency=1)

    async def trabalho_com_erro() -> None:
        async with fila:
            raise RuntimeError("falha proposta")

    with pytest.raises(RuntimeError):
        await trabalho_com_erro()

    # O slot deve ter sido liberado: outra tarefa consegue entrar imediatamente.
    entrou = False
    async with fila:
        entrou = True
    assert entrou is True
