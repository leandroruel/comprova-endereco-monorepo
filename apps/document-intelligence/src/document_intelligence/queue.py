"""Controle de concorrência para processamento documental.

O Marker carrega modelos que consomem memória/CPU consideráveis. Este módulo
expõe um :class:`asyncio.Semaphore` para limitar a quantidade de documentos
processados simultaneamente por processo, evitando concorrência ilimitada.
"""

from __future__ import annotations

import asyncio


class ProcessingQueue:
    """Fila com limite de concorrência para processamento de documentos."""

    def __init__(self, max_concurrency: int) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency deve ser >= 1")
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self.max_concurrency = max_concurrency

    async def acquire(self) -> None:
        await self._semaphore.acquire()

    def release(self) -> None:
        self._semaphore.release()

    async def __aenter__(self) -> "ProcessingQueue":
        await self.acquire()
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.release()

    @property
    def available_slots(self) -> int:
        """Número aproximado de slots livres (apenas informativo)."""
        return self._semaphore._value  # type: ignore[attr-defined]
