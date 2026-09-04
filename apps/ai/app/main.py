"""DataSynx AI service.

Perception (detection, OCR, transcription, extraction) lives here; every
physical quantity is produced by the deterministic measurement engines. When an
engine's dependency or model is missing the service answers 503 with the reason
rather than returning invented data.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import Depends, FastAPI, Header, HTTPException

from .config import resolve_device, settings
from .engines import ENGINES
from .errors import EngineUnavailable
from .measure_ops import OPERATIONS, run_operation
from .schemas import MeasureRequest, ProcessingOutput, ProcessRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("datasynx.ai")

app = FastAPI(title="DataSynx AI Service", version="1.0.0")


def authorize(authorization: str = Header(default="")) -> None:
    expected = settings().token
    supplied = authorization.removeprefix("Bearer ").strip()
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid AI service token")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": settings().mode}


@app.get("/v1/capabilities", dependencies=[Depends(authorize)])
def capabilities() -> dict[str, object]:
    engines = {}
    for name, engine in ENGINES.items():
        available, detail = engine.availability()
        engines[name] = {"available": available, "detail": detail}
    return {
        "mode": settings().mode,
        "device": resolve_device(),
        "engines": engines,
        "measurements": sorted(OPERATIONS),
    }


@app.post("/v1/process/{engine_name}", dependencies=[Depends(authorize)], response_model=ProcessingOutput)
def process(engine_name: str, request: ProcessRequest) -> ProcessingOutput:
    engine = ENGINES.get(engine_name)
    if engine is None:
        raise HTTPException(status_code=404, detail=f"Unknown engine '{engine_name}'")

    mode = request.mode or settings().mode
    if mode == "demo":
        logger.info("engine=%s reference=%s mode=demo", engine_name, request.fileReference)
        return engine.demo(request)

    available, detail = engine.availability()
    if not available:
        raise EngineUnavailable(f"{engine_name} engine unavailable: {detail}")

    logger.info("engine=%s reference=%s mode=real", engine_name, request.fileReference)
    return engine.run(request)


@app.post("/v1/measure", dependencies=[Depends(authorize)])
def measure(request: MeasureRequest) -> dict[str, object]:
    return run_operation(request.operation, request.params)
