"""Controle de admissão e concorrência para processamento documental.

O Marker carrega modelos que consomem memória/CPU consideráveis. Este módulo
limita quantas requisições podem estar **admitidas** por processo — em
processamento ou aguardando o worker — para que uploads simultâneos não
acumulem PDFs inteiros em memória.

A admissão é **não bloqueante** (:meth:`ProcessingQueue.try_acquire`): quando a
capacidade está esgotada, o chamador rejeita a requisição (HTTP 429) em vez de
enfileirá-la indefinidamente. O ``acquire`` bloqueante continua disponível para
uso como context manager.
"""

from __future__ import annotations

import asyncio
import threading

# Granularidade do ``acquire`` bloqueante (usado apenas como context manager;
# a rota usa ``try_acquire`` e nunca espera).
_ACQUIRE_POLL_SECONDS = 0.01


class ProcessingQueue:
    """Admissão com capacidade limitada para processamento de documentos.

    A capacidade total é ``max_concurrency + max_queue``: ``max_concurrency``
    slots para o worker de inferência e ``max_queue`` slots para requisições
    admitidas que ainda aguardam. Não há fila ilimitada.
    """

    def __init__(self, max_concurrency: int, max_queue: int = 0) -> None:
        """Valida os limites e inicializa o contador de slots em uso."""
        if max_concurrency < 1:
            raise ValueError("max_concurrency deve ser >= 1")
        if max_queue < 0:
            raise ValueError("max_queue deve ser >= 0")
        self.max_concurrency = max_concurrency
        self.max_queue = max_queue
        self.capacity = max_concurrency + max_queue
        # Contador protegido por lock: a rota e o callback do future rodam no
        # event loop, mas testes/host embarcados podem usar mais de um loop.
        self._in_flight = 0
        self._lock = threading.Lock()

    def try_acquire(self) -> bool:
        """Admite sem bloquear; devolve ``False`` se a capacidade esgotou."""
        with self._lock:
            if self._in_flight >= self.capacity:
                return False
            self._in_flight += 1
            return True

    async def acquire(self) -> None:
        """Admite aguardando até haver slot livre (context manager)."""
        while not self.try_acquire():
            await asyncio.sleep(_ACQUIRE_POLL_SECONDS)

    def release(self) -> None:
        """Libera um slot admitido (idempotente quanto ao piso zero)."""
        with self._lock:
            if self._in_flight > 0:
                self._in_flight -= 1

    async def __aenter__(self) -> "ProcessingQueue":
        """Adquire um slot ao entrar no contexto."""
        await self.acquire()
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        """Libera o slot ao sair do contexto, mesmo com exceção."""
        self.release()

    @property
    def in_flight(self) -> int:
        """Slots admitidos agora (em processamento + aguardando)."""
        with self._lock:
            return self._in_flight

    @property
    def available_slots(self) -> int:
        """Número de slots livres (apenas informativo)."""
        with self._lock:
            return max(self.capacity - self._in_flight, 0)


class AdmissionSlot:
    """Slot de admissão transferível, com liberação idempotente.

    O middleware HTTP adquire o slot **antes** de o corpo do upload ser lido e
    é responsável por liberá-lo se a requisição terminar sem entregar trabalho
    ao worker (validação, 413, cancelamento, erro ao agendar). Ao agendar, a
    rota transfere o slot para o ``done_callback`` do future, que só libera
    quando a thread de inferência realmente termina.

    ``release`` é idempotente: chamadas repetidas (middleware + callback) não
    devolvem capacidade a mais.
    """

    __slots__ = ("_queue", "_acquired", "_released", "_transferred")

    def __init__(self, queue: ProcessingQueue) -> None:
        self._queue = queue
        self._acquired = False
        self._released = False
        self._transferred = False

    def try_acquire(self) -> bool:
        """Tenta admitir sem bloquear; ``False`` quando a capacidade esgotou."""
        if self._acquired:
            return True
        if not self._queue.try_acquire():
            return False
        self._acquired = True
        return True

    def transfer(self) -> None:
        """Entrega a liberação ao worker (``done_callback`` do future)."""
        if self._acquired:
            self._transferred = True

    @property
    def transferred(self) -> bool:
        """True quando a liberação passou a ser responsabilidade do worker."""
        return self._transferred

    def release(self) -> None:
        """Libera o slot uma única vez (no-op se nunca adquirido)."""
        if not self._acquired or self._released:
            return
        self._released = True
        self._queue.release()
