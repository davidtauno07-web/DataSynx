"""Invoice engine: deterministic field extraction, optional LLM refinement.

Absent fields stay null. Totals are never computed to "fill in" a missing
value; when the printed arithmetic disagrees with the line items we emit a
warning instead of silently rewriting the document.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from dateutil import parser as date_parser

from ..download import download, suffix_for
from ..errors import EngineFailed
from ..providers import get_provider
from ..schemas import CompilationRow, ProcessingOutput, ProcessRequest
from .base import Engine
from .document import extract_text

COLUMNS = [
    "Invoice",
    "Supplier",
    "Customer",
    "Invoice date",
    "Due date",
    "Currency",
    "Subtotal",
    "Tax",
    "Total",
    "PO number",
    "Line items",
]

CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "kr": "SEK", "₹": "INR"}

FIELD_PATTERNS: dict[str, list[str]] = {
    "invoiceNumber": [
        r"invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-/_]{2,})",
        r"\barve\s*(?:nr\.?|number)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-/_]{2,})",
    ],
    "purchaseOrder": [r"(?:purchase order|p\.?o\.?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9\-/_]{3,})"],
    "invoiceDate": [
        r"invoice date\s*[:\-]?\s*([0-9]{1,4}[./\- ][0-9A-Za-z]{1,9}[./\- ][0-9]{2,4})",
        r"\bdate\s*[:\-]\s*([0-9]{1,4}[./\- ][0-9A-Za-z]{1,9}[./\- ][0-9]{2,4})",
    ],
    "dueDate": [r"(?:due date|payment due|due)\s*[:\-]?\s*([0-9]{1,4}[./\- ][0-9A-Za-z]{1,9}[./\- ][0-9]{2,4})"],
    "supplier": [r"(?:supplier|vendor|from|seller|bill from)\s*[:\-]\s*(.+)"],
    "customer": [r"(?:customer|bill to|invoice to|buyer|client)\s*[:\-]\s*(.+)"],
    "iban": [r"\b([A-Z]{2}[0-9]{2}[A-Z0-9]{10,30})\b"],
}

AMOUNT_PATTERNS: dict[str, list[str]] = {
    "subtotal": [r"(?:subtotal|net total|net amount|amount excl[^\n:]*)\s*[:\-]?\s*([^\n]+)"],
    "tax": [r"(?:vat|tax|sales tax|k[äa]ibemaks)[^\n:]*[:\-]?\s*([^\n]+)"],
    # `(?<![a-z])` keeps "Subtotal" from being read as the invoice total.
    "total": [r"(?:total due|grand total|amount due|total amount|(?<![a-z])total)\s*[:\-]?\s*([^\n]+)"],
}

LINE_ITEM_RE = re.compile(
    r"^(?P<description>[A-Za-z][^\n]{2,60}?)\s{2,}"
    r"(?P<quantity>\d+(?:[.,]\d+)?)\s+"
    r"(?P<unitPrice>[€$£]?\s?\d[\d\s.,]*)\s+"
    r"(?P<amount>[€$£]?\s?\d[\d\s.,]*)$"
)


def parse_amount(raw: str | None) -> float | None:
    if not raw:
        return None
    match = re.search(r"-?\d[\d\s.,]*", raw)
    if not match:
        return None
    token = match.group(0).replace(" ", "").replace("\u00a0", "")
    if "," in token and "." in token:
        decimal_is_dot = token.rfind(".") > token.rfind(",")
        token = token.replace(",", "") if decimal_is_dot else token.replace(".", "").replace(",", ".")
    elif "," in token:
        token = token.replace(",", ".") if len(token.split(",")[-1]) in (1, 2) else token.replace(",", "")
    try:
        return round(float(token), 2)
    except ValueError:
        return None


def parse_date(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        parsed = date_parser.parse(raw, dayfirst=True, fuzzy=True).date()
    except (ValueError, OverflowError):
        return None
    return parsed.isoformat() if isinstance(parsed, date) else None


def detect_currency(text: str) -> str | None:
    iso = re.search(r"\b(EUR|USD|GBP|SEK|NOK|DKK|CHF|PLN|INR|AUD|CAD)\b", text)
    if iso:
        return iso.group(1)
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in text:
            return code
    return None


def first_match(text: str, patterns: list[str]) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            value = match.group(1).strip(" .:;-\t")
            if value:
                return value
    return None


def extract_line_items(text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for line in text.splitlines():
        match = LINE_ITEM_RE.match(line.rstrip())
        if not match:
            continue
        description = match.group("description").strip()
        if re.search(r"subtotal|total|vat|tax", description, re.IGNORECASE):
            continue
        items.append(
            {
                "description": description,
                "quantity": parse_amount(match.group("quantity")),
                "unitPrice": parse_amount(match.group("unitPrice")),
                "amount": parse_amount(match.group("amount")),
            }
        )
    return items


def rule_based_extract(text: str) -> dict[str, Any]:
    fields: dict[str, Any] = {key: first_match(text, patterns) for key, patterns in FIELD_PATTERNS.items()}
    fields["invoiceDate"] = parse_date(fields.get("invoiceDate"))
    fields["dueDate"] = parse_date(fields.get("dueDate"))
    for key, patterns in AMOUNT_PATTERNS.items():
        fields[key] = parse_amount(first_match(text, patterns))
    fields["currency"] = detect_currency(text)
    fields["lineItems"] = extract_line_items(text)
    return fields


LLM_SCHEMA = {
    "invoiceNumber": "string|null",
    "supplier": "string|null",
    "supplierAddress": "string|null",
    "customer": "string|null",
    "invoiceDate": "ISO date|null",
    "dueDate": "ISO date|null",
    "currency": "ISO 4217 code|null",
    "subtotal": "number|null",
    "tax": "number|null",
    "total": "number|null",
    "purchaseOrder": "string|null",
    "iban": "string|null",
    "lineItems": [
        {"description": "string", "quantity": "number|null", "unitPrice": "number|null", "amount": "number|null"}
    ],
}


def validate(fields: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    subtotal, tax, total = fields.get("subtotal"), fields.get("tax"), fields.get("total")
    if subtotal is not None and tax is not None and total is not None and abs((subtotal + tax) - total) > 0.02:
        warnings.append(
            f"Printed totals do not reconcile: subtotal {subtotal} + tax {tax} ≠ total {total}. Values left as printed."
        )
    items = fields.get("lineItems") or []
    amounts = [item["amount"] for item in items if isinstance(item.get("amount"), (int, float))]
    if amounts and subtotal is not None and abs(sum(amounts) - subtotal) > 0.02:
        warnings.append("Line-item sum differs from the printed subtotal; both are reported unchanged.")
    for required in ("invoiceNumber", "total"):
        if fields.get(required) in (None, ""):
            warnings.append(f"Field '{required}' was not present in the document and is reported as unavailable.")
    return warnings


class InvoiceEngine(Engine):
    name = "invoice"
    version = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        provider = get_provider()
        refinement = f" + {provider.name} LLM refinement" if provider else " (no LLM configured)"
        return True, f"rule-based extraction{refinement}"

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        with download(request.fileUrl, suffix_for(request.originalName)) as path:
            text, _pages, warnings, source = extract_text(path, request.mimeType, request.originalName)
        if not text:
            raise EngineFailed("No readable text could be extracted from this invoice")

        fields = rule_based_extract(text)

        provider = get_provider()
        if provider is not None:
            refined = provider.extract("Extract the invoice fields.", text, LLM_SCHEMA)
            if refined:
                for key, value in refined.items():
                    if value in (None, "", []) or key not in LLM_SCHEMA:
                        continue
                    if key in {"subtotal", "tax", "total"}:
                        value = parse_amount(str(value))
                    if key in {"invoiceDate", "dueDate"}:
                        value = parse_date(str(value))
                    if fields.get(key) in (None, "", []):
                        fields[key] = value
            else:
                warnings.append("LLM refinement was unavailable; rule-based extraction was used")

        warnings += validate(fields)

        summary: dict[str, Any] = {
            "Invoice number": fields.get("invoiceNumber"),
            "Supplier": fields.get("supplier"),
            "Supplier address": fields.get("supplierAddress"),
            "Customer": fields.get("customer"),
            "Invoice date": fields.get("invoiceDate"),
            "Due date": fields.get("dueDate"),
            "Currency": fields.get("currency"),
            "Subtotal": fields.get("subtotal"),
            "Tax": fields.get("tax"),
            "Total": fields.get("total"),
            "Purchase order": fields.get("purchaseOrder"),
            "Payment (IBAN)": fields.get("iban"),
            "Line items": fields.get("lineItems"),
            "Extraction": source,
        }

        row = CompilationRow(
            rowKey=request.fileReference,
            data={
                "Invoice": fields.get("invoiceNumber"),
                "Supplier": fields.get("supplier"),
                "Customer": fields.get("customer"),
                "Invoice date": fields.get("invoiceDate"),
                "Due date": fields.get("dueDate"),
                "Currency": fields.get("currency"),
                "Subtotal": fields.get("subtotal"),
                "Tax": fields.get("tax"),
                "Total": fields.get("total"),
                "PO number": fields.get("purchaseOrder"),
                "Line items": len(fields.get("lineItems") or []),
            },
        )
        present = sum(1 for key in ("invoiceNumber", "supplier", "invoiceDate", "total") if fields.get(key))
        return self.output(
            summary=summary,
            columns=COLUMNS,
            rows=[row],
            warnings=warnings,
            confidence=round(present / 4, 2),
        )

    def demo(self, request: ProcessRequest) -> ProcessingOutput:
        row = CompilationRow(
            rowKey=request.fileReference,
            data=dict.fromkeys(COLUMNS, None) | {"Invoice": "DEMO", "Supplier": "DEMO MODE"},
        )
        return self.output(
            summary={"Invoice number": "DEMO", "Note": "DEMO MODE — no invoice was parsed"},
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: this result is synthetic and must not be treated as real processing"],
            demo=True,
        )
