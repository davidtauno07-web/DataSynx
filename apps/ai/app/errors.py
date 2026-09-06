from __future__ import annotations

from fastapi import HTTPException


class EngineUnavailable(HTTPException):
    """Raised when an engine's dependency/model is missing.

    The API surfaces this to the user verbatim; results are never fabricated.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=503, detail=detail)


class EngineFailed(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(status_code=422, detail=detail)
