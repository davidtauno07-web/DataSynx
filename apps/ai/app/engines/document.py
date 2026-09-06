"""Document engine: PDF/DOCX/TXT/CSV/XLSX parsing with OCR fallback."""

from __future__ import annotations

import csv
import io
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..download import download, suffix_for
from ..errors import EngineFailed, EngineUnavailable
from ..schemas import CompilationRow, ProcessingOutput, ProcessRequest
from .base import Engine, optional_module

if TYPE_CHECKING:
    from pypdf import PageObject

COLUMNS = ["Document", "Type", "Pages", "Words", "Characters", "Source", "Summary"]


def _pdf_page_text(page: PageObject) -> str:
    """Layout extraction preserves column spacing and avoids kerning artefacts such as "T otal"."""
    try:
        layout = page.extract_text(extraction_mode="layout")
    except (TypeError, ValueError, KeyError):
        layout = ""
    return layout or page.extract_text() or ""


def extract_text(path: Path, mime: str, name: str) -> tuple[str, int, list[str], str]:
    """Returns (text, page_count, warnings, extraction source)."""
    suffix = Path(name).suffix.lower()
    warnings: list[str] = []

    if suffix == ".pdf" or mime == "application/pdf":
        pypdf = optional_module("pypdf")
        if pypdf is None:
            raise EngineUnavailable("PDF parsing is unavailable: install the 'pypdf' dependency")
        reader = pypdf.PdfReader(str(path))
        pages = [_pdf_page_text(page) for page in reader.pages]
        text = "\n".join(pages).strip()
        if text:
            return text, len(pages), warnings, "pdf-text-layer"
        ocr_text, ocr_warnings = ocr_pdf(path)
        return ocr_text, len(pages), warnings + ocr_warnings, "ocr"

    if suffix == ".docx":
        docx = optional_module("docx")
        if docx is None:
            raise EngineUnavailable("DOCX parsing is unavailable: install the 'python-docx' dependency")
        document = docx.Document(str(path))
        blocks = [p.text for p in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                blocks.append(" | ".join(cell.text for cell in row.cells))
        return "\n".join(blocks).strip(), 1, warnings, "docx"

    if suffix in {".txt", ".md", ".log"} or mime.startswith("text/plain"):
        return path.read_text(encoding="utf-8", errors="replace").strip(), 1, warnings, "text"

    if suffix == ".csv" or mime == "text/csv":
        rows = list(csv.reader(io.StringIO(path.read_text(encoding="utf-8", errors="replace"))))
        return "\n".join(", ".join(row) for row in rows), 1, warnings, "csv"

    if suffix in {".xlsx", ".xlsm"}:
        openpyxl = optional_module("openpyxl")
        if openpyxl is None:
            raise EngineUnavailable("XLSX parsing is unavailable: install the 'openpyxl' dependency")
        workbook = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
        lines: list[str] = []
        for sheet in workbook.worksheets:
            lines.append(f"# {sheet.title}")
            for row in sheet.iter_rows(values_only=True):
                lines.append(", ".join("" if cell is None else str(cell) for cell in row))
        return "\n".join(lines).strip(), len(workbook.worksheets), warnings, "xlsx"

    if mime.startswith("image/"):
        text, ocr_warnings = ocr_image(path)
        return text, 1, warnings + ocr_warnings, "ocr"

    raise EngineFailed(f"Unsupported document type: {mime or suffix or 'unknown'}")


def ocr_image(path: Path) -> tuple[str, list[str]]:
    pytesseract = optional_module("pytesseract")
    pil = optional_module("PIL.Image")
    if pytesseract is None or pil is None:
        raise EngineUnavailable(
            "OCR is unavailable: install 'pytesseract' plus the tesseract binary to process scanned documents"
        )
    try:
        return pytesseract.image_to_string(pil.open(str(path))).strip(), []
    except Exception as exc:  # pragma: no cover - depends on tesseract install
        raise EngineUnavailable(f"OCR failed: {exc}") from exc


def ocr_pdf(path: Path) -> tuple[str, list[str]]:
    convert = optional_module("pdf2image")
    if convert is None:
        raise EngineUnavailable(
            "This PDF has no text layer and OCR for PDFs is unavailable: install 'pdf2image' + 'pytesseract'"
        )
    pages = convert.convert_from_path(str(path))
    pytesseract = optional_module("pytesseract")
    if pytesseract is None:
        raise EngineUnavailable("OCR is unavailable: install 'pytesseract' plus the tesseract binary")
    text = "\n".join(pytesseract.image_to_string(page) for page in pages)
    return text.strip(), ["Text extracted with OCR; accuracy depends on scan quality"]


def classify(text: str, name: str) -> str:
    lowered = f"{name}\n{text[:4000]}".lower()
    rules = [
        ("invoice", ("invoice", "vat", "amount due", "arve")),
        ("contract", ("agreement", "contract", "party", "hereby")),
        ("report", ("report", "summary", "findings")),
        ("receipt", ("receipt", "paid", "change due")),
        ("letter", ("dear ", "sincerely", "yours faithfully")),
    ]
    for label, keywords in rules:
        if any(keyword in lowered for keyword in keywords):
            return label
    return "document"


def summarise(text: str, limit: int = 400) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    return collapsed[:limit] + ("…" if len(collapsed) > limit else "")


class DocumentEngine(Engine):
    name = "document"
    version = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        detail = "pypdf/python-docx ready"
        if optional_module("pytesseract") is None:
            detail += "; OCR disabled (pytesseract missing)"
        return True, detail

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        with download(request.fileUrl, suffix_for(request.originalName)) as path:
            text, pages, warnings, source = extract_text(path, request.mimeType, request.originalName)

        if not text:
            raise EngineFailed("No readable text could be extracted from this document")

        words = len(text.split())
        doc_type = classify(text, request.originalName)
        summary: dict[str, Any] = {
            "Document": request.originalName,
            "Reference": request.fileReference,
            "Type": doc_type,
            "Pages": pages,
            "Words": words,
            "Characters": len(text),
            "Extraction": source,
            "Summary": summarise(text),
            "Text": text[:20000],
        }
        row = CompilationRow(
            rowKey=request.fileReference,
            data={
                "Document": request.originalName,
                "Type": doc_type,
                "Pages": pages,
                "Words": words,
                "Characters": len(text),
                "Source": source,
                "Summary": summarise(text, 200),
            },
        )
        return self.output(summary=summary, columns=COLUMNS, rows=[row], warnings=warnings)

    def demo(self, request: ProcessRequest) -> ProcessingOutput:
        summary = {
            "Document": request.originalName,
            "Type": "document",
            "Pages": 1,
            "Words": 0,
            "Summary": "DEMO MODE — no document parsing was performed",
        }
        row = CompilationRow(
            rowKey=request.fileReference,
            data={
                "Document": request.originalName,
                "Type": "demo",
                "Pages": 1,
                "Words": 0,
                "Characters": 0,
                "Source": "demo",
                "Summary": "DEMO MODE",
            },
        )
        return self.output(
            summary=summary,
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: this result is synthetic and must not be treated as real processing"],
            demo=True,
        )
