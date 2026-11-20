"""Aplicação FastAPI do serviço Document Intelligence.

Endpoints:
    GET  /health      — liveness: 200 enquanto o processo está vivo (sem Tesseract)
    GET  /ready       — readiness: 200 só com Tesseract instalado, idioma 'por'
                        disponível, warmup concluído e memória suficiente;
                        senão 503
    POST /documents/parse — recebe PDF via multipart e retorna JSON estruturado;
                        capacidade esgotada → 429 antes de ler o upload

O processamento roda localmente com Tesseract 5 + pypdfium2, sem VLM, sem
Marker e sem llama.cpp. O processamento é CPU-bound e roda em um
``ThreadPoolExecutor`` com paralelismo limitado.
"""

from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

import psutil
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .logging import configure_logging, get_logger
from .ocr import is_tesseract_available, tesseract_version
from .pdf_processor import build_parse_response
from .queue import AdmissionSlot, ProcessingQueue
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

# Leitura do upload em blocos de 1 MiB para aplicar o limite de tamanho
# antes de manter o payload inteiro em memória.
_UPLOAD_CHUNK_BYTES = 1024 * 1024

# Instâncias compartilhadas (carregadas no startup / first use).
# Não há modelo a carregar: o parser funciona sobre demanda.
parser_ready = False
parser_warmed = False
# Disponibilidade do Tesseract verificada no startup (evita subprocesso
# bloqueante no endpoint /health). Atualizada pelo lifespan.
tesseract_available_at_startup = False
# Capacidade = worker(s) + aguardando. Excedente recebe 429 antes de ler o
# corpo do upload (não acumula PDFs em memória).
queue = ProcessingQueue(
    max_concurrency=settings.max_concurrency,
    max_queue=settings.max_queue,
)
executor = ThreadPoolExecutor(
    max_workers=settings.max_concurrency,
    thread_name_prefix="di-tesseract",
)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001 - app usado implicitamente
    """Verifica Tesseract no startup e agenda o warmup em background.

    Falha de verificação não derruba o serviço: ``/ready`` reporta o erro e o
    orquestrador não roteia tráfego enquanto o estado for ``not_ready``.
    """
    configure_logging(level=settings.log_level, log_file=settings.log_file)
    logger.info(
        "servico_iniciando",
        porta=settings.port,
        max_concorrencia=settings.max_concurrency,
        timeout_s=settings.timeout_s,
        max_arquivo_mb=settings.max_file_size_mb,
        max_paginas=settings.max_pages,
        warmup=settings.warmup,
        ocr_lang=settings.ocr_lang,
    )
    global parser_ready, tesseract_available_at_startup
    # Não derruba o serviço se a verificação falhar: /ready reporta o erro.
    try:
        await asyncio.get_running_loop().run_in_executor(
            executor, _verify_tesseract
        )
        parser_ready = True
        tesseract_available_at_startup = True
    except Exception as exc:  # pragma: no cover - falha de ambiente
        logger.error(
            "falha_ao_verificar_tesseract",
            error_type=type(exc).__name__,
            error=str(exc),
        )
    if settings.warmup:
        # Aquecimento em background: /health responde imediatamente e /ready
        # sinaliza "não pronto" até o aquecimento concluir.
        asyncio.create_task(_run_warmup())
    yield
    executor.shutdown(wait=False, cancel_futures=True)
    logger.info("servico_encerrando")


def _verify_tesseract() -> None:
    """Verifica se o Tesseract está instalado e com o idioma configurado disponível.

    Levanta exceção se não estiver disponível — o lifespan captura e loga.
    """
    if not is_tesseract_available(settings.ocr_lang):
        raise RuntimeError(
            f"Tesseract não está instalado ou o idioma '{settings.ocr_lang}' "
            f"não está disponível"
        )
    logger.info(
        "tesseract_disponivel",
        versao=tesseract_version(),
        idioma=settings.ocr_lang,
    )


async def _run_warmup() -> None:
    """Executa o warmup do parser no executor; falhas já são logadas lá."""
    global parser_warmed
    try:
        await asyncio.get_running_loop().run_in_executor(executor, _warmup)
        parser_warmed = True
    except Exception:  # pragma: no cover - já logado no warmup
        pass


def _warmup() -> None:
    """Executa um documento sintético para verificar o pipeline de OCR.

    O primeiro processamento pode carregar recursos adicionais do Tesseract.
    Rodar isto no startup evita que a primeira requisição real estoure o
    timeout. O PDF de warmup e gerado sem camada textual, forçando o uso
    do Tesseract; o warmup só eh considerado concluido se o OCR retornar
    texto reconhecido.
    """
    import os

    from .ocr import ocr_image, render_page_to_image
    from .security import temporary_pdf_path
    from .warmup import build_warmup_pdf

    logger.info("aquecendo_pipeline_ocr")
    start = time.perf_counter()
    try:
        with temporary_pdf_path(
            build_warmup_pdf(), prefix="di-warmup-", dir=settings.temp_dir
        ) as path:
            response = build_parse_response(path, "warmup", size_bytes=0)
            if response.status != "completed":
                raise RuntimeError(
                    f"aquecimento falhou: {response.error_code}"
                )

            # Exercita o caminho de OCR do Tesseract: renderiza a pagina e
            # executa OCR para garantir que o binario e o idioma estejam prontos.
            img_path, width_px, height_px = render_page_to_image(
                path, 1, dpi=settings.ocr_dpi
            )
            try:
                lines = ocr_image(
                    img_path,
                    lang=settings.ocr_lang,
                    page_width_px=width_px,
                    page_height_px=height_px,
                    dpi=settings.ocr_dpi,
                )
                if not lines:
                    raise RuntimeError(
                        "aquecimento falhou: OCR nao retornou texto reconhecido"
                    )
            finally:
                try:
                    os.unlink(img_path)
                except FileNotFoundError:
                    pass
        logger.info(
            "pipeline_ocr_aquecido",
            duracao_ms=int((time.perf_counter() - start) * 1000),
        )
    except Exception as exc:  # pragma: no cover - falha de ambiente
        logger.error(
            "falha_no_aquecimento_do_pipeline",
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise


app = FastAPI(
    title="Document Intelligence",
    description="Processamento documental com Tesseract (OCR, sem VLM, sem LLM)",
    version="0.1.0",
    lifespan=lifespan,
)

# Habilita CORS para permitir que o frontend (ex: dashboard na porta 5173)
# acesse a API em outra porta (ex: 8000).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rota de trabalho pesado protegida por admissão.
_ADMISSION_PATH = "/documents/parse"
_CAPACITY_DETAIL = "Serviço ocupado; tente novamente em instantes."


@app.middleware("http")
async def admission_control(request: Request, call_next: Any) -> Any:
    """Admite a requisição **antes** de o corpo do upload ser lido.

    Sem isso, cada requisição simultânea carregaria o PDF inteiro em memória
    antes de entrar na fila. Quando a capacidade (``max_concurrency +
    max_queue``) está esgotada, responde ``429`` sem ler o corpo. O slot é
    liberado no ``finally`` se a rota não o tiver transferido ao worker.
    """
    if request.method != "POST" or request.url.path != _ADMISSION_PATH:
        return await call_next(request)

    slot = AdmissionSlot(queue)
    if not slot.try_acquire():
        logger.warning("capacidade_esgotada", capacidade=queue.capacity)
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": _CAPACITY_DETAIL},
            headers={"Retry-After": "5"},
        )

    request.state.admission_slot = slot
    try:
        return await call_next(request)
    finally:
        if not slot.transferred:
            slot.release()


@app.get("/health", response_model=HealthResponse, tags=["health"])
async def health() -> HealthResponse:
    """Status do serviço. Não carrega modelos nem depende de warmup.

    Não executa subprocessos bloqueantes: a disponibilidade do Tesseract é
    a verificada no startup e armazenada em ``tesseract_available_at_startup``.
    A liveness é independente da disponibilidade do Tesseract.
    """
    return HealthResponse(
        status="ok",
        tesseract_available=tesseract_available_at_startup,
    )


@app.get(
    "/ready",
    response_model=ReadyResponse,
    tags=["health"],
    responses={
        503: {"model": ReadyResponse, "description": "Ainda não pronto"}
    },
)
async def ready(response: Response) -> ReadyResponse:
    """Indica se o serviço está pronto para receber inferências.

    Retorna **HTTP 200** somente quando o Tesseract está disponível (com
    idioma ``por``), o warmup concluiu (quando habilitado) e há memória livre
    suficiente. Caso contrário, **HTTP 503** com ``status: "not_ready"``.
    """
    checks: dict[str, str] = {}
    ready_status = "ready"

    checks["tesseract"] = (
        f"disponível ({settings.ocr_lang})"
        if tesseract_available_at_startup
        else "não disponível"
    )
    if not tesseract_available_at_startup:
        ready_status = "not_ready"

    if settings.warmup:
        checks["aquecimento"] = "concluído" if parser_warmed else "em andamento"
        if not parser_warm_available():
            ready_status = "not_ready"

    # Requisitos mínimos: memória livre.
    available_mb = int(psutil.virtual_memory().available / (1024 * 1024))
    checks["memoria_livre_mb"] = str(available_mb)
    if available_mb < settings.min_free_memory_mb:
        ready_status = "not_ready"

    checks["concorrencia_max"] = str(settings.max_concurrency)
    checks["fila_em_uso"] = f"{queue.in_flight}/{queue.capacity}"
    checks["tamanho_maximo_arquivo_mb"] = str(settings.max_file_size_mb)
    checks["timeout_s"] = str(settings.timeout_s)
    checks["max_paginas"] = str(settings.max_pages)

    if ready_status != "ready":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return ReadyResponse(
        status=ready_status,  # type: ignore[arg-type]
        models_loaded=parser_ready,
        checks=checks,
    )


def parser_warm_available() -> bool:
    """Retorna se o warmup está concluído (ou desabilitado)."""
    if not settings.warmup:
        return True
    return parser_warmed


async def _read_upload_bounded(file: UploadFile) -> bytes:
    """Lê o upload em blocos, abortando com 413 ao exceder o limite.

    Evita receber e manter em memória um payload maior que o configurado: a
    leitura para no primeiro bloco que estourar ``DI_MAX_FILE_SIZE_MB``.
    """
    max_bytes = settings.max_file_size_mb * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"arquivo excede o limite de {settings.max_file_size_mb} MiB"
                ),
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _process_document(
    data: bytes,
    filename: str,
    declared_content_type: str | None,
    request_id: str,
) -> ParseResponse:
    """Pipeline síncrono completo; roda no executor de worker único.

    Tudo aqui bloqueia a thread: escrita do temporário, inspeção PDFium e
    parse com Tesseract. Rodar na mesma thread serializa o PDFium com o OCR
    (o PDFium não é thread-safe) e libera o event loop para ``/health`` e
    ``/ready``. Erros de domínio (``SecurityError`` e subclasses) são
    mapeados para HTTP pelo handler assíncrono.
    """
    uploaded = validate_uploaded_pdf(
        data=data,
        filename=filename,
        declared_content_type=declared_content_type,
        max_size_bytes=settings.max_file_size_mb * 1024 * 1024,
    )
    with temporary_pdf_path(
        uploaded.data, prefix="di-", dir=settings.temp_dir
    ) as pdf_path:
        # Inspeção barata (sem OCR): páginas e criptografia.
        inspect_pdf(pdf_path, max_pages=settings.max_pages)
        return build_parse_response(pdf_path, request_id, uploaded.size_bytes)


@app.post("/documents/parse", response_model=ParseResponse, tags=["documents"])
async def parse_document(
    request: Request,
    file: UploadFile = File(..., description="Arquivo PDF a ser processado"),
    document_id: str | None = Form(
        default=None, description="Identificador opcional de processamento"
    ),
) -> ParseResponse:
    """Recebe um PDF via ``multipart/form-data`` e retorna JSON estruturado.

    Fluxo e garantias:
    - **admissão antes da leitura**: se a capacidade (worker + fila) está
      esgotada, responde ``429`` sem carregar o corpo em memória;
    - somente PDFs válidos (assinatura ``%PDF-`` + magic bytes);
    - tamanho dentro do limite configurado (leitura em blocos, 413 cedo);
    - PDF não criptografado e dentro do limite de páginas;
    - nome de arquivo temporário aleatório com limpeza garantida.

    O slot de admissão é liberado em todos os caminhos: erro de validação,
    upload acima do limite, falha ao agendar o executor, cancelamento do
    cliente e timeout. Quando o trabalho já está no worker, a liberação
    acontece no callback do future — nunca antes de a thread terminar.
    """
    request_id = document_id or generate_document_id()
    start = time.perf_counter()

    # O middleware de admissão já adquiriu o slot ANTES de ler o corpo. O
    # fallback cobre chamadas diretas à rota sem o middleware (testes/embeds).
    slot: AdmissionSlot | None = getattr(request.state, "admission_slot", None)
    created_slot = slot is None
    if slot is None:
        slot = AdmissionSlot(queue)
        if not slot.try_acquire():
            logger.warning(
                "capacidade_esgotada",
                document_id=request_id,
                capacidade=queue.capacity,
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=_CAPACITY_DETAIL,
                headers={"Retry-After": "5"},
            )

    try:
        data = await _read_upload_bounded(file)

        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(
            executor,
            _process_document,
            data,
            file.filename or "documento.pdf",
            file.content_type,
            request_id,
        )
        # O slot passa a ser liberado quando a thread realmente termina —
        # nem no fim da requisição, nem no timeout/cancelamento do cliente.
        future.add_done_callback(lambda _: slot.release())
        slot.transfer()

        try:
            response = await asyncio.wait_for(
                asyncio.shield(future), timeout=settings.timeout_s
            )
        except EncryptedPDFError as exc:
            logger.warning("pdf_criptografado", document_id=request_id)
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
                "rejeicao_por_seguranca",
                document_id=request_id,
                motivo=str(exc),
                tamanho_bytes=len(data),
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
            ) from exc
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
    finally:
        if created_slot and not slot.transferred:
            slot.release()

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
        tesseract_version=response.metadata.processor_version,
    )
    return response


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
