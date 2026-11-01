"""Testes unitários da fila de concorrência (não dependem do Marker)."""

import asyncio

import pytest

from document_intelligence.queue import AdmissionSlot, ProcessingQueue


def test_try_acquire_respeita_capacidade_total() -> None:
    """Capacidade = worker + aguardando; o excedente é recusado sem bloquear."""
    fila = ProcessingQueue(max_concurrency=1, max_queue=1)

    assert fila.capacity == 2
    assert fila.try_acquire() is True
    assert fila.try_acquire() is True
    assert fila.try_acquire() is False  # sem fila ilimitada
    assert fila.in_flight == 2
    assert fila.available_slots == 0

    fila.release()
    assert fila.available_slots == 1
    assert fila.try_acquire() is True


def test_release_nao_fica_negativo() -> None:
    """Liberações extras não devolvem capacidade a mais."""
    fila = ProcessingQueue(max_concurrency=1, max_queue=0)

    fila.release()
    fila.release()
    assert fila.in_flight == 0
    assert fila.try_acquire() is True


def test_slot_de_admissao_e_idempotente_e_transferivel() -> None:
    """``AdmissionSlot`` libera uma vez e pode ser entregue ao worker."""
    fila = ProcessingQueue(max_concurrency=1)
    slot = AdmissionSlot(fila)

    assert slot.try_acquire() is True
    assert fila.in_flight == 1

    slot.transfer()
    assert slot.transferred is True

    # Middleware e callback podem chamar release; só conta uma vez.
    slot.release()
    slot.release()
    assert fila.in_flight == 0


def test_slot_de_admissao_nao_libera_sem_adquirir() -> None:
    """``release`` de um slot não adquirido é no-op."""
    fila = ProcessingQueue(max_concurrency=1)
    slot = AdmissionSlot(fila)

    assert slot.try_acquire() is True
    outro = AdmissionSlot(fila)
    assert outro.try_acquire() is False
    outro.release()

    assert fila.in_flight == 1
    slot.release()
    assert fila.in_flight == 0


def test_capacidade_invalida_e_rejeitada() -> None:
    """Valores inválidos falham cedo na construção."""
    with pytest.raises(ValueError):
        ProcessingQueue(max_concurrency=0)
    with pytest.raises(ValueError):
        ProcessingQueue(max_concurrency=1, max_queue=-1)


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
