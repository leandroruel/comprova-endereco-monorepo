"""Aplicação FastAPI do serviço Document Intelligence.

Endpoints:
    GET  /health      — status do serviço (não carrega modelos)
    GET  /ready       — modelos carregados e recursos disponíveis
    POST /documents/parse — recebe PDF via multipart e retorna JSON estruturado

Os modelos do Marker são carregados uma única vez no startup (configurável por
``DI_PRELOAD_MODELS``) e reutilizados entre requisições. O processamento é
CPU-bound e roda em um ``ThreadPoolExecutor`` com paralelismo limitado.
"""

from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

import psutil
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from .config import settings
from .logging import configure_logging, get_logger
from .parser import CONTRACT_VERSION, MarkerParser
from .queue import ProcessingQueue
from .schemas import (
    DocumentInfo,
    HealthResponse,
    ParseResponse,
    ProcessingMetadata,
    ReadyResponse,
)
from .security import (
    EncryptedPDFError,
    PageLimitError,
    SecurityError,
    generate_document_id,
    inspect_pdf,
    temporary_pdf_path,
    validate_uploaded_pdf,
)

logger = get_logger("document-intelligence.main")

# Instâncias compartilhadas (carregadas no startup / first use).
parser = MarkerParser()
queue = ProcessingQueue(max_concurrency=settings.max_concurrency)
executor = ThreadPoolExecutor(
    max_workers=settings.max_concurrency,
    thread_name_prefix="di-marker",
)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001 - app usado implicitamente
    configure_logging(level=settings.log_level, log_file=settings.log_file)
    logger.info(
        "servico_iniciando",
        porta=settings.port,
        max_concorrencia=settings.max_concurrency,
        timeout_s=settings.timeout_s,
        max_arquivo_mb=settings.max_file_size_mb,
        max_paginas=settings.max_pages,
        preload_models=settings.preload_models,
        warmup=settings.warmup,
    )
    if settings.preload_models:
        # Não derruba o serviço se o carregamento falhar: /ready reporta o erro.
        try:
            await asyncio.get_running_loop().run_in_executor(
                executor, parser.load_models
            )
        except Exception as exc:  # pragma: no cover - falha de ambiente
            logger.error(
                "falha_ao_precarregar_modelos",
                error_type=type(exc).__name__,
                error=str(exc),
            )
    if settings.warmup and settings.preload_models:
        # Aquecimento em background: /health responde imediatamente e /ready
        # sinaliza "não pronto" até o aquecimento concluir.
        asyncio.create_task(_run_warmup())
    yield
    executor.shutdown(wait=False, cancel_futures=True)
    logger.info("servico_encerrando")


async def _run_warmup() -> None:
    try:
        await asyncio.get_running_loop().run_in_executor(executor, parser.warmup)
    except Exception:  # pragma: no cover - já logado no parser
        pass


app = FastAPI(
    title="Document Intelligence",
    description="Processamento documental com Marker (OCR + layout, sem LLM)",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse, tags=["health"])
async def health() -> HealthResponse:
    """Status do serviço. Não carrega modelos do Marker."""
    return HealthResponse(status="ok", marker_available=_marker_importable())


@app.get("/ready", response_model=ReadyResponse, tags=["health"])
async def ready() -> ReadyResponse:
    """Indica se o serviço está pronto para processar documentos."""
    checks: dict[str, str] = {}
    ready_status = "ready"

    checks["marker_modelos"] = (
        "carregados" if parser.models_loaded else "não carregados"
    )
    if not parser.models_loaded:
        ready_status = "not_ready"

    if settings.warmup:
        checks["aquecimento"] = "concluído" if parser.warm else "em andamento"
        if not parser.warm:
            ready_status = "not_ready"

    # Recursos: memória livre e escrita no diretório temporário.
    available_mb = int(psutil.virtual_memory().available / (1024 * 1024))
    checks["memoria_livre_mb"] = str(available_mb)
    if available_mb < settings.min_free_memory_mb:
        ready_status = "not_ready"

    checks["concorrencia_max"] = str(settings.max_concurrency)
    checks["tamanho_maximo_arquivo_mb"] = str(settings.max_file_size_mb)
    checks["timeout_s"] = str(settings.timeout_s)
    checks["max_paginas"] = str(settings.max_pages) if settings.max_pages else "sem limite"

    return ReadyResponse(
        status=ready_status,  # type: ignore[arg-type]
        models_loaded=parser.models_loaded,
        checks=checks,
    )


@app.post("/documents/parse", response_model=ParseResponse, tags=["documents"])
async def parse_document(
    file: UploadFile = File(..., description="Arquivo PDF a ser processado"),
    document_id: str | None = Form(
        default=None, description="Identificador opcional de processamento"
    ),
) -> ParseResponse:
    """Recebe um PDF via ``multipart/form-data`` e retorna JSON estruturado.

    Validações de segurança:
    - somente PDFs válidos (assinatura ``%PDF-`` + magic bytes);
    - tamanho dentro do limite configurado;
    - PDF não criptografado e dentro do limite de páginas;
    - nome de arquivo temporário aleatório com limpeza garantida.
    """
    request_id = document_id or generate_document_id()
    start = time.perf_counter()

    data = await file.read()

    try:
        uploaded = validate_uploaded_pdf(
            data=data,
            filename=file.filename or "documento.pdf",
            declared_content_type=file.content_type,
            max_size_bytes=settings.max_file_size_mb * 1024 * 1024,
        )
    except SecurityError as exc:
        logger.warning(
            "rejeicao_por_seguranca",
            document_id=request_id,
            motivo=str(exc),
            tamanho_bytes=len(data),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    async with queue:
        with temporary_pdf_path(
            uploaded.data,
            prefix="di-",
            dir=settings.temp_dir,
        ) as pdf_path:
            # Inspeção barata (sem modelos): páginas e criptografia.
            try:
                inspect_pdf(pdf_path, max_pages=settings.max_pages)
            except EncryptedPDFError as exc:
                logger.warning(
                    "pdf_criptografado", document_id=request_id
                )
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(exc),
                ) from exc
            except PageLimitError as exc:
                logger.warning(
                    "pdf_acima_do_limite_de_paginas", document_id=request_id
                )
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(exc),
                ) from exc
            except SecurityError as exc:
                logger.warning(
                    "pdf_invalido", document_id=request_id, motivo=str(exc)
                )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
                ) from exc

            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(
                executor,
                parser.parse,
                pdf_path,
                request_id,
                uploaded.size_bytes,
            )
            try:
                response = await asyncio.wait_for(
                    future, timeout=settings.timeout_s
                )
            except (asyncio.TimeoutError, TimeoutError) as exc:
                logger.error(
                    "timeout_no_processamento",
                    document_id=request_id,
                    timeout_s=settings.timeout_s,
                )
                raise HTTPException(
                    status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                    detail=(
                        f"O processamento excedeu o timeout de "
                        f"{settings.timeout_s}s"
                    ),
                ) from exc

    duracao_ms = int((time.perf_counter() - start) * 1000)
    log = logger.info if response.status == "completed" else logger.error
    log(
        "processamento_concluido",
        document_id=request_id,
        status=response.status,
        paginas=response.document.page_count,
        duracao_ms=duracao_ms,
        avisos=len(response.warnings),
        error_type=response.error_code,
        marker_version=response.metadata.processor_version,
    )
    return response


def _marker_importable() -> bool:
    try:
        import marker  # noqa: F401

        return True
    except Exception:
        return False


@app.exception_handler(Exception)
async def unhandled_exception_handler(
    request: Any, exc: Exception  # noqa: ARG001
) -> JSONResponse:
    """Não expor stack traces ao consumidor."""
    logger.error("erro_nao_tratado", error_type=type(exc).__name__)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Erro interno ao processar a requisição."},
    )
