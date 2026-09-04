"""Runtime configuration for the DataSynx AI service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    token: str
    mode: str
    host: str
    port: int
    device: str
    detection_model: str
    detection_confidence: float
    whisper_model: str
    max_video_frames: int
    frame_sample_fps: float
    download_timeout: float
    max_download_bytes: int

    @property
    def demo(self) -> bool:
        return self.mode == "demo"


@lru_cache
def settings() -> Settings:
    return Settings(
        token=os.environ.get("AI_SERVICE_TOKEN", "dev-ai-token"),
        mode=os.environ.get("DATASYNX_MODE", "real").lower(),
        host=os.environ.get("AI_SERVICE_HOST", "0.0.0.0"),
        port=int(os.environ.get("AI_SERVICE_PORT", "8000")),
        device=os.environ.get("AI_DEVICE", "auto"),
        detection_model=os.environ.get("AI_DETECTION_MODEL", "yolov8n.pt"),
        detection_confidence=float(os.environ.get("AI_DETECTION_CONFIDENCE", "0.35")),
        whisper_model=os.environ.get("AI_WHISPER_MODEL", "base"),
        max_video_frames=int(os.environ.get("AI_MAX_VIDEO_FRAMES", "900")),
        frame_sample_fps=float(os.environ.get("AI_FRAME_SAMPLE_FPS", "5")),
        download_timeout=float(os.environ.get("AI_DOWNLOAD_TIMEOUT", "120")),
        max_download_bytes=int(os.environ.get("AI_MAX_DOWNLOAD_BYTES", str(4 * 1024**3))),
    )


def resolve_device() -> str:
    """Reports the accelerator the vision/audio engines will use."""
    configured = settings().device
    if configured != "auto":
        return configured
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # pragma: no cover - torch is optional
        pass
    return "cpu"
