"""Replaceable object-detection/tracking boundary.

The default implementation is Ultralytics YOLO (CPU or GPU). Swapping in a
different runtime only requires another `Detector` implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..config import resolve_device, settings
from ..errors import EngineUnavailable
from .base import optional_module


@dataclass
class Detection:
    label: str
    confidence: float
    box: tuple[float, float, float, float]  # x1, y1, x2, y2
    track_id: int | None = None
    frame: int = 0
    timestamp: float = 0.0

    @property
    def centroid(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.box
        return ((x1 + x2) / 2, (y1 + y2) / 2)


@dataclass
class Track:
    track_id: int
    label: str
    detections: list[Detection] = field(default_factory=list)

    @property
    def first(self) -> Detection:
        return self.detections[0]

    @property
    def last(self) -> Detection:
        return self.detections[-1]

    @property
    def duration(self) -> float:
        return max(self.last.timestamp - self.first.timestamp, 0.0)


class Detector(Protocol):
    name: str

    def detect_image(self, path: Path, classes: list[str] | None) -> list[Detection]: ...

    def track_video(self, path: Path, classes: list[str] | None) -> tuple[list[Track], dict[str, Any]]: ...


class UltralyticsDetector:
    name = "ultralytics-yolo"

    def __init__(self) -> None:
        module = optional_module("ultralytics")
        if module is None:
            raise EngineUnavailable(
                "Object detection is unavailable: install 'ultralytics' (see backend/ai/requirements-optional.txt) "
                "and provide the model weights configured by AI_DETECTION_MODEL"
            )
        cfg = settings()
        self.device = resolve_device()
        self.confidence = cfg.detection_confidence
        try:
            self.model = module.YOLO(cfg.detection_model)
        except Exception as exc:  # pragma: no cover - depends on weights availability
            raise EngineUnavailable(f"Detection model '{cfg.detection_model}' could not be loaded: {exc}") from exc

    def _class_filter(self, classes: list[str] | None) -> list[int] | None:
        if not classes:
            return None
        names: dict[int, str] = self.model.names
        wanted = {c.lower() for c in classes}
        ids = [idx for idx, label in names.items() if label.lower() in wanted]
        return ids or None

    def detect_image(self, path: Path, classes: list[str] | None) -> list[Detection]:
        results = self.model.predict(
            str(path), conf=self.confidence, classes=self._class_filter(classes), device=self.device, verbose=False
        )
        detections: list[Detection] = []
        for result in results:
            for box in result.boxes:
                detections.append(
                    Detection(
                        label=result.names[int(box.cls)],
                        confidence=float(box.conf),
                        box=tuple(float(v) for v in box.xyxy[0].tolist()),  # type: ignore[arg-type]
                    )
                )
        return detections

    def track_video(self, path: Path, classes: list[str] | None) -> tuple[list[Track], dict[str, Any]]:
        cfg = settings()
        cv2 = optional_module("cv2")
        fps = 0.0
        if cv2 is not None:
            capture = cv2.VideoCapture(str(path))
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            capture.release()

        stream = self.model.track(
            source=str(path),
            conf=self.confidence,
            classes=self._class_filter(classes),
            device=self.device,
            tracker="bytetrack.yaml",
            persist=True,
            stream=True,
            verbose=False,
        )

        tracks: dict[int, Track] = {}
        frames = 0
        for frame_index, result in enumerate(stream):
            frames += 1
            if frame_index >= cfg.max_video_frames:
                break
            timestamp = frame_index / fps if fps else 0.0
            for box in result.boxes:
                if box.id is None:
                    continue
                track_id = int(box.id)
                label = result.names[int(box.cls)]
                detection = Detection(
                    label=label,
                    confidence=float(box.conf),
                    box=tuple(float(v) for v in box.xyxy[0].tolist()),  # type: ignore[arg-type]
                    track_id=track_id,
                    frame=frame_index,
                    timestamp=timestamp,
                )
                tracks.setdefault(track_id, Track(track_id=track_id, label=label)).detections.append(detection)

        meta = {"fps": fps, "frames": frames, "device": self.device, "model": settings().detection_model}
        return sorted(tracks.values(), key=lambda t: t.first.frame), meta


def get_detector() -> Detector:
    return UltralyticsDetector()


def detector_availability() -> tuple[bool, str]:
    if optional_module("ultralytics") is None:
        return False, "ultralytics not installed (object detection disabled)"
    if optional_module("cv2") is None:
        return False, "opencv-python-headless not installed (video decoding disabled)"
    return True, f"ultralytics YOLO on {resolve_device()}"
