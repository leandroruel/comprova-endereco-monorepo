"""Validações de segurança para upload de PDF.

- Validação da assinatura PDF (``%PDF-``) — nunca confiar apenas no ``Content-Type``.
- Validação do tipo real via magic bytes (``filetype``).
- Nome de arquivo temporário aleatório (``uuid4``) com limpeza garantida.
- Detecção de path traversal no nome do arquivo.
- Contagem de páginas e detecção de PDF criptografado (``pypdfium2``).
"""

from __future__ import annotations

import os
import secrets
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

import filetype
import pypdfium2 as pdfium

PDF_SIGNATURE = b"%PDF-"


class SecurityError(ValueError):
    """Erro de validação de segurança do arquivo enviado."""


class EncryptedPDFError(SecurityError):
    """O PDF está protegido por senha e não pode ser processado."""


class PageLimitError(SecurityError):
    """O PDF excede o limite configurado de páginas."""


@dataclass(frozen=True)
class UploadedFile:
    data: bytes
    filename: str
    declared_content_type: str | None
    detected_content_type: str | None
    size_bytes: int


def validate_uploaded_pdf(
    data: bytes,
    filename: str | None,
    declared_content_type: str | None,
    max_size_bytes: int,
) -> UploadedFile:
    """Valida um arquivo enviado.

    Verifica:
    - tamanho dentro do limite;
    - não vazio;
    - assinatura PDF real (``%PDF-``);
    - detecção de tipo via magic bytes compatível com PDF;
    - nome de arquivo sem componentes de diretório (path traversal).
    """

    if len(data) == 0:
        raise SecurityError("arquivo vazio")
    if len(data) > max_size_bytes:
        raise SecurityError(
            f"arquivo excede o limite de {max_size_bytes // (1024 * 1024)} MiB"
        )

    # Assinatura PDF: os primeiros 5 bytes devem ser %PDF-
    if not data.startswith(PDF_SIGNATURE):
        raise SecurityError(
            "arquivo não é um PDF válido (assinatura %PDF- ausente)"
        )

    # Detecção de tipo real via magic bytes (não confiar apenas no Content-Type)
    kind = filetype.guess(data)
    detected_content_type = kind.mime if kind is not None else None
    if detected_content_type is not None and detected_content_type != "application/pdf":
        raise SecurityError(
            f"tipo de arquivo detectado ({detected_content_type}) não é application/pdf"
        )

    # Nome de arquivo: somente o componente final, sem diretórios. Rejeita
    # separadores POSIX e Windows explicitamente (nunca usamos o nome para
    # montar caminho, mas a validação é defesa em profundidade).
    safe_filename = os.path.basename(filename or "documento.pdf")
    if filename is not None and (
        safe_filename != filename or "/" in filename or "\\" in filename
    ):
        raise SecurityError("nome de arquivo contém componentes de diretório")

    return UploadedFile(
        data=data,
        filename=safe_filename,
        declared_content_type=declared_content_type,
        detected_content_type=detected_content_type,
        size_bytes=len(data),
    )


def inspect_pdf(path: str, max_pages: int | None = None) -> int:
    """Inspeciona um PDF e retorna o número de páginas.

    Levanta :class:`EncryptedPDFError` se o PDF estiver protegido por senha e
    :class:`PageLimitError` se exceder ``max_pages``.
    """
    try:
        document = pdfium.PdfDocument(path)
    except pdfium.PdfiumError as exc:
        # PDFs criptografados exigem senha na abertura e caem aqui.
        message = str(exc).lower()
        if "password" in message or "encrypted" in message:
            raise EncryptedPDFError(
                "PDF protegido por senha não é suportado"
            ) from exc
        raise SecurityError(f"PDF inválido ou corrompido: {exc}") from exc

    try:
        page_count = len(document)
        if page_count == 0:
            raise SecurityError("PDF não contém páginas")
        if max_pages is not None and page_count > max_pages:
            raise PageLimitError(
                f"PDF tem {page_count} páginas; o limite configurado é {max_pages}"
            )
        return page_count
    finally:
        document.close()


@contextmanager
def temporary_pdf_path(
    data: bytes, prefix: str = "di-", dir: str | None = None
) -> Iterator[str]:
    """Cria um arquivo temporário com nome aleatório e garante a limpeza."""

    fd, path = tempfile.mkstemp(prefix=prefix, suffix=".pdf", dir=dir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def generate_document_id() -> str:
    """Gera um identificador de processamento aleatório (não sequencial)."""

    return secrets.token_urlsafe(16)
