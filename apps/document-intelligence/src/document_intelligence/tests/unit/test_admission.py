"""Testes do controle de admissão (capacidade) do endpoint de parsing.

Não carregam modelos: ``parser.parse`` é substituído por um stub controlado
por ``threading.Event``. O que se valida aqui é o ciclo de vida do slot —
antes da leitura do upload, em erros, no timeout, no cancelamento e na falha
inesperada — e não a inferência do Marker.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from document_intelligence import main
from document_intelligence.queue import ProcessingQueue
from document_intelligence.schemas import (
    DocumentInfo,
    ParseResponse,
    ProcessingMetadata,
)


def _fake_response(document_id: str, pages: int = 1) -> ParseResponse:
    """Resposta de sucesso compatível com o contrato."""
    return ParseResponse(
        document_id=document_id,
        status="completed",
        document=DocumentInfo(
            mime_type="application/pdf", page_count=pages, size_bytes=100
        ),
        content={"text": "ok", "markdown": "ok"},
        pages=[],
        metadata=ProcessingMetadata(
            processor_version="2.1.0", processing_time_ms=1
        ),
    )


@contextmanager
def _env(
    monkeypatch: pytest.MonkeyPatch,
    max_concurrency: int = 1,
    max_queue: int = 0,
) -> Iterator[ProcessingQueue]:
    """Instala fila e executor isolados (sem modelos) para o teste."""
    fila = ProcessingQueue(
        max_concurrency=max_concurrency, max_queue=max_queue
    )
    executor = ThreadPoolExecutor(
        max_workers=max_concurrency, thread_name_prefix="test-di"
    )
    monkeypatch.setattr(main, "queue", fila)
    monkeypatch.setattr(main, "executor", executor)
    try:
        yield fila
    finally:
        executor.shutdown(wait=True)


def _wait_until(predicate, timeout: float = 10.0) -> bool:
    """Aguarda (thread) até ``predicate`` ou estouro do timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


async def _await_until(predicate, timeout: float = 10.0) -> bool:
    """Aguarda (async) até ``predicate`` ou estouro do timeout."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return False


def _fake_read_bounded(reads: list[int]):
    """Substitui a leitura real do upload registrando cada chamada."""

    async def _read(_file) -> bytes:
        reads.append(1)
        return b""

    return _read


def _post(client: TestClient, pdf: bytes):
    return client.post(
        "/documents/parse",
        files={"file": ("documento.pdf", pdf, "application/pdf")},
    )


def test_concorrencia_respeita_capacidade_e_excedente_recebe_429(
    monkeypatch: pytest.MonkeyPatch, sample_text_pdf: Path
) -> None:
    """Capacidade = worker + aguardando; a terceira requisição recebe 429."""
    pdf = sample_text_pdf.read_bytes()
    started = threading.Event()
    release = threading.Event()
    lock = threading.Lock()
    running = 0
    max_running = 0
    calls: list[str] = []

    def fake_parse(path, document_id, size_bytes=0):
        nonlocal running, max_running
        with lock:
            running += 1
            max_running = max(max_running, running)
            calls.append(document_id)
        started.set()
        release.wait(10)
        with lock:
            running -= 1
        return _fake_response(document_id)

    monkeypatch.setattr(main.parser, "parse", fake_parse)

    with _env(monkeypatch, max_concurrency=1, max_queue=1) as fila:
        results: dict[str, httpx.Response] = {}

        def post(name: str) -> None:
            results[name] = _post(TestClient(main.app), pdf)

        first = threading.Thread(target=post, args=("r1",))
        first.start()
        assert started.wait(10), "worker não iniciou"

        second = threading.Thread(target=post, args=("r2",))
        second.start()
        assert _wait_until(lambda: fila.in_flight == 2), "segundo slot não admitido"

        # Capacidade esgotada (1 processando + 1 aguardando).
        excess = _post(TestClient(main.app), pdf)
        assert excess.status_code == 429
        assert excess.headers["retry-after"] == "5"

        release.set()
        first.join(15)
        second.join(15)

        assert results["r1"].status_code == 200
        assert results["r2"].status_code == 200
        # Nunca houve mais de uma inferência simultânea (executor de 1 worker).
        assert max_running == 1
        assert _wait_until(lambda: fila.in_flight == 0)
        assert len(calls) == 2


def test_upload_nao_e_lido_quando_capacidade_esgotada(
    monkeypatch: pytest.MonkeyPatch, sample_text_pdf: Path
) -> None:
    """A rejeição 429 acontece antes de qualquer leitura do upload."""
    pdf = sample_text_pdf.read_bytes()
    reads: list[int] = []

    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        assert fila.try_acquire() is True  # ocupa o único slot

        monkeypatch.setattr(
            main, "_read_upload_bounded", _fake_read_bounded(reads)
        )
        response = _post(TestClient(main.app), pdf)

        assert response.status_code == 429
        assert reads == [], "o corpo do upload foi lido mesmo sem capacidade"

        # Com o slot livre, a leitura volta a acontecer (e falha na validação).
        fila.release()
        assert _post(TestClient(main.app), pdf).status_code == 400
        assert reads == [1]


def test_slot_liberado_apos_erro_de_validacao(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """400 não deixa slot preso: a próxima requisição é admitida."""
    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        client = TestClient(main.app)

        first = client.post(
            "/documents/parse",
            files={"file": ("nao.pdf", b"nao eh pdf", "application/pdf")},
        )
        assert first.status_code == 400
        assert _wait_until(lambda: fila.in_flight == 0)

        second = client.post(
            "/documents/parse",
            files={"file": ("nao.pdf", b"nao eh pdf", "application/pdf")},
        )
        assert second.status_code == 400  # não 429: o slot foi liberado


def test_slot_ocupado_enquanto_inferencia_continua_apos_timeout(
    monkeypatch: pytest.MonkeyPatch, sample_text_pdf: Path
) -> None:
    """Timeout responde 504, mas o slot só é liberado quando a thread termina."""
    pdf = sample_text_pdf.read_bytes()
    started = threading.Event()
    release = threading.Event()

    def fake_parse(path, document_id, size_bytes=0):
        started.set()
        release.wait(15)
        return _fake_response(document_id)

    monkeypatch.setattr(main.parser, "parse", fake_parse)
    monkeypatch.setattr(main.settings, "timeout_s", 1)

    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        # Um único loop/portal durante o teste: em produção o event loop é
        # persistente e o callback do future sempre roda.
        with TestClient(main.app) as client:
            started_at = time.monotonic()
            timed_out = _post(client, pdf)
            assert timed_out.status_code == 504
            assert time.monotonic() - started_at < 10
            assert started.is_set()

            # A inferência continua rodando: o slot permanece ocupado.
            assert fila.in_flight == 1
            assert _post(client, pdf).status_code == 429

            release.set()
            assert _wait_until(
                lambda: fila.in_flight == 0
            ), "slot preso após timeout"

            # Depois do término real, uma nova requisição é admitida.
            assert _post(client, pdf).status_code == 200


@pytest.mark.asyncio
async def test_cancelamento_do_cliente_nao_libera_slot_antes(
    monkeypatch: pytest.MonkeyPatch, sample_text_pdf: Path
) -> None:
    """Cancelar a requisição não devolve capacidade com a thread ainda ativa."""
    pdf = sample_text_pdf.read_bytes()
    started = threading.Event()
    release = threading.Event()

    def fake_parse(path, document_id, size_bytes=0):
        started.set()
        release.wait(15)
        return _fake_response(document_id)

    monkeypatch.setattr(main.parser, "parse", fake_parse)

    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            task = asyncio.create_task(_post_async(client, pdf))
            assert await asyncio.to_thread(started.wait, 10)

            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            # O cancelamento encerrou a requisição, mas a thread continua.
            assert fila.in_flight == 1

            release.set()
            assert await _await_until(lambda: fila.in_flight == 0)

            response = await _post_async(client, pdf)
            assert response.status_code == 200


async def _post_async(
    client: httpx.AsyncClient, pdf: bytes
) -> httpx.Response:
    return await client.post(
        "/documents/parse",
        files={"file": ("documento.pdf", pdf, "application/pdf")},
    )


def test_sem_slots_presos_apos_excecao_inesperada(
    monkeypatch: pytest.MonkeyPatch, sample_text_pdf: Path
) -> None:
    """Exceção no worker não vaza capacidade."""
    pdf = sample_text_pdf.read_bytes()

    def boom(path, document_id, size_bytes=0):
        raise RuntimeError("falha simulada no worker")

    monkeypatch.setattr(main.parser, "parse", boom)

    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        client = TestClient(main.app, raise_server_exceptions=False)
        assert _post(client, pdf).status_code == 500
        assert _wait_until(lambda: fila.in_flight == 0), "slot preso após exceção"

        # E o serviço volta a admitir requisições.
        assert _post(client, pdf).status_code == 500  # não 429


def test_slot_liberado_quando_agendamento_no_executor_falha(
    monkeypatch: pytest.MonkeyPatch, sample_text_pdf: Path
) -> None:
    """Executor encerrado: erro ao agendar não deixa o slot preso."""
    pdf = sample_text_pdf.read_bytes()

    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        main.executor.shutdown(wait=False)

        client = TestClient(main.app, raise_server_exceptions=False)
        assert _post(client, pdf).status_code == 500
        assert _wait_until(lambda: fila.in_flight == 0), "slot preso após falha"


def test_middleware_nao_interfere_em_outras_rotas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``/health`` e ``/ready`` não consomem nem liberam slots."""
    with _env(monkeypatch, max_concurrency=1, max_queue=0) as fila:
        client = TestClient(main.app)
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code in (200, 503)
        assert fila.in_flight == 0
