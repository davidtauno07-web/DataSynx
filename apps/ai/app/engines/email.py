"""Email engine: structures messages the user explicitly selected."""

from __future__ import annotations

import re
from typing import Any

from dateutil import parser as date_parser

from ..errors import EngineFailed
from ..schemas import CompilationRow, ProcessingOutput, ProcessRequest
from .base import Engine

COLUMNS = ["Email", "Sender", "Recipients", "Subject", "Date", "Attachments", "Entities", "Summary"]

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
URL_RE = re.compile(r"https?://[^\s<>\"]+")
MONEY_RE = re.compile(r"(?:[€$£]\s?\d[\d\s.,]*|\b\d[\d\s.,]*\s?(?:EUR|USD|GBP)\b)")
PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
ORG_RE = re.compile(r"\b([A-Z][A-Za-z&.\-]+(?:\s+[A-Z][A-Za-z&.\-]+)*)\s+(?:O[UÜ]|Ltd|LLC|Inc|GmbH|AS|AB|SA|BV|PLC)\b")


def strip_html(body: str) -> str:
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>|</p>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def extract_entities(text: str) -> dict[str, list[str]]:
    def unique(values: list[str]) -> list[str]:
        return sorted({v.strip() for v in values if v.strip()})

    dates: list[str] = []
    for candidate in re.findall(r"\b\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b", text):
        try:
            dates.append(date_parser.parse(candidate, dayfirst=True).date().isoformat())
        except (ValueError, OverflowError):
            continue

    return {
        "emails": unique(EMAIL_RE.findall(text)),
        "organizations": unique(ORG_RE.findall(text)),
        "urls": unique(URL_RE.findall(text)),
        "amounts": unique(MONEY_RE.findall(text)),
        "phones": unique(PHONE_RE.findall(text)),
        "dates": unique(dates),
    }


class EmailEngine(Engine):
    name = "email"
    version = "1.0.0"

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        payload: dict[str, Any] = request.payload or {}
        if not payload:
            raise EngineFailed("No email payload was provided for this item")

        body = payload.get("bodyText") or strip_html(str(payload.get("bodyHtml") or ""))
        recipients = payload.get("to") or []
        cc = payload.get("cc") or []
        attachments = payload.get("attachments") or []
        entities = extract_entities(f"{payload.get('subject', '')}\n{body}")

        summary: dict[str, Any] = {
            "Subject": payload.get("subject"),
            "Sender": payload.get("from"),
            "Recipients": recipients,
            "CC": cc,
            "Date": payload.get("date"),
            "Attachments": [a.get("filename") for a in attachments],
            "People and addresses": entities["emails"],
            "Organizations": entities["organizations"],
            "Dates mentioned": entities["dates"],
            "Amounts mentioned": entities["amounts"],
            "Links": entities["urls"],
            "Body": body[:20000],
        }

        row = CompilationRow(
            rowKey=request.fileReference,
            data={
                "Email": payload.get("messageId") or request.fileReference,
                "Sender": payload.get("from"),
                "Recipients": ", ".join(recipients),
                "Subject": payload.get("subject"),
                "Date": payload.get("date"),
                "Attachments": len(attachments),
                "Entities": len(entities["emails"]) + len(entities["organizations"]),
                "Summary": re.sub(r"\s+", " ", body)[:200],
            },
        )
        return self.output(summary=summary, columns=COLUMNS, rows=[row])

    def demo(self, request: ProcessRequest) -> ProcessingOutput:
        row = CompilationRow(rowKey=request.fileReference, data=dict.fromkeys(COLUMNS, None) | {"Email": "DEMO"})
        return self.output(
            summary={"Subject": "DEMO MODE", "Note": "No email was processed"},
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: synthetic result"],
            demo=True,
        )
