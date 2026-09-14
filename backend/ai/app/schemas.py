"""Wire contract shared with the Node API (mirrors backend/api/src/domain/results.ts)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

MeasurementStatus = Literal["MEASURED", "ESTIMATED", "UNAVAILABLE"]


class Measurement(BaseModel):
    subject: str
    parameter: str
    value: float | None = None
    unit: str | None = None
    status: MeasurementStatus
    method: str | None = None
    source: str | None = None
    quality: str | None = None
    confidence: float | None = None
    reason: str | None = None


class CompilationRow(BaseModel):
    rowKey: str
    data: dict[str, Any]
    geometry: dict[str, Any] | None = None


class Compilation(BaseModel):
    columns: list[str]
    rows: list[CompilationRow]


class ClipSpec(BaseModel):
    """A contextual clip window the API should cut from the original media."""

    clipKey: str
    subject: str
    objectType: str
    sequence: int
    startTime: float
    endTime: float
    eventTime: float
    durationSeconds: float
    kinds: list[str] = Field(default_factory=list)
    events: list[dict[str, Any]] = Field(default_factory=list)
    reason: str = ""


class ProcessingOutput(BaseModel):
    engine: str
    engineVersion: str
    demo: bool = False
    summary: dict[str, Any]
    measurements: list[Measurement] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    confidence: float | None = None
    clips: list[ClipSpec] = Field(default_factory=list)
    compilation: Compilation


class ProcessRequest(BaseModel):
    fileUrl: str | None = None
    fileReference: str
    originalName: str
    mimeType: str
    sizeBytes: int = 0
    mode: Literal["real", "demo"] = "real"
    options: dict[str, Any] = Field(default_factory=dict)
    payload: dict[str, Any] = Field(default_factory=dict)


class MeasureRequest(BaseModel):
    operation: str
    params: dict[str, Any] = Field(default_factory=dict)
