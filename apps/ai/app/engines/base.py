from __future__ import annotations

import importlib
from typing import Any

from ..schemas import Compilation, CompilationRow, ProcessingOutput, ProcessRequest


class Engine:
    """A modality-specific pipeline. Engines never invent data."""

    name: str = "engine"
    version: str = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        return True, "ready"

    def run(self, request: ProcessRequest) -> ProcessingOutput:  # pragma: no cover - interface
        raise NotImplementedError

    def demo(self, request: ProcessRequest) -> ProcessingOutput:  # pragma: no cover - interface
        raise NotImplementedError

    def output(
        self,
        *,
        summary: dict[str, Any],
        columns: list[str],
        rows: list[CompilationRow],
        measurements: list[Any] | None = None,
        warnings: list[str] | None = None,
        confidence: float | None = None,
        demo: bool = False,
    ) -> ProcessingOutput:
        return ProcessingOutput(
            engine=self.name,
            engineVersion=self.version,
            demo=demo,
            summary=summary,
            measurements=measurements or [],
            warnings=warnings or [],
            confidence=confidence,
            compilation=Compilation(columns=columns, rows=rows),
        )


def optional_module(name: str) -> Any | None:
    """Imports a heavy optional dependency, returning None when unavailable."""
    try:
        return importlib.import_module(name)
    except Exception:  # pragma: no cover - depends on deployment
        return None


def has_module(name: str) -> bool:
    return optional_module(name) is not None
