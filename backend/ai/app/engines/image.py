"""Generic image engine: properties, optional detection, optional OCR text."""

from __future__ import annotations

from typing import Any

from ..download import download, suffix_for
from ..errors import EngineFailed
from ..schemas import CompilationRow, Measurement, ProcessingOutput, ProcessRequest
from .base import Engine, optional_module
from .document import ocr_image
from .vision import detector_availability, get_detector

COLUMNS = ["Image", "Width", "Height", "Format", "Objects", "Detected classes", "Text"]


class ImageEngine(Engine):
    name = "image"
    version = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        ok, detail = detector_availability()
        return True, f"image properties ready; detection: {'ready' if ok else detail}"

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        pil = optional_module("PIL.Image")
        if pil is None:
            raise EngineFailed("Image processing requires the 'Pillow' dependency")

        warnings: list[str] = []
        detections: list[Any] = []
        text: str | None = None

        with download(request.fileUrl, suffix_for(request.originalName)) as path:
            with pil.open(str(path)) as handle:
                width, height = handle.size
                image_format = handle.format
            try:
                detections = get_detector().detect_image(path, (request.options or {}).get("classes"))
            except Exception as exc:
                warnings.append(getattr(exc, "detail", str(exc)))
            if (request.options or {}).get("ocr"):
                try:
                    text, _ = ocr_image(path)
                except Exception as exc:
                    warnings.append(getattr(exc, "detail", str(exc)))

        classes = sorted({d.label for d in detections})
        summary: dict[str, Any] = {
            "Image": request.originalName,
            "Dimensions": f"{width} × {height}",
            "Format": image_format,
            "Detected objects": len(detections),
            "Detected classes": classes,
            "Objects": [
                {"label": d.label, "confidence": round(d.confidence, 3), "box": [round(v, 1) for v in d.box]}
                for d in detections
            ],
            "Text": text,
        }
        row = CompilationRow(
            rowKey=request.fileReference,
            data={
                "Image": request.originalName,
                "Width": width,
                "Height": height,
                "Format": image_format,
                "Objects": len(detections),
                "Detected classes": ", ".join(classes) or None,
                "Text": (text or "")[:200] or None,
            },
        )
        measurements = [
            Measurement(
                subject=request.originalName,
                parameter="resolution",
                value=float(width * height),
                unit="px",
                status="MEASURED",
                method="image header",
                source="image",
            )
        ]
        return self.output(
            summary=summary, columns=COLUMNS, rows=[row], measurements=measurements, warnings=warnings
        )

    def demo(self, request: ProcessRequest) -> ProcessingOutput:
        row = CompilationRow(rowKey=request.fileReference, data=dict.fromkeys(COLUMNS, None) | {"Image": "DEMO"})
        return self.output(
            summary={"Image": request.originalName, "Note": "DEMO MODE"},
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: synthetic result"],
            demo=True,
        )
