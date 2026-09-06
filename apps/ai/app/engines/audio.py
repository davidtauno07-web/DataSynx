"""Audio engine: ffmpeg preprocessing, energy VAD, optional speech recognition.

The original recording is never modified — ffmpeg writes a temporary working
copy that is discarded after the run.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Any

import numpy as np

from ..config import resolve_device, settings
from ..download import download, suffix_for
from ..errors import EngineFailed, EngineUnavailable
from ..schemas import CompilationRow, ProcessingOutput, ProcessRequest
from .base import Engine, optional_module

COLUMNS = ["Recording", "Segment", "Speaker", "Start", "End", "Duration", "Transcript"]
TARGET_RATE = 16_000


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def probe_duration(path: Path) -> float | None:
    if shutil.which("ffprobe") is None:
        return None
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return None


def preprocess(source: Path, target: Path) -> None:
    """Mono 16 kHz + high-pass (hum), gentle noise gate and loudness normalisation."""
    filters = "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", str(TARGET_RATE), "-af", filters, str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not target.exists():
        raise EngineFailed(f"Audio could not be decoded: {result.stderr.strip()[-400:]}")


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        frames = handle.readframes(handle.getnframes())
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def voice_activity(samples: np.ndarray, rate: int = TARGET_RATE) -> list[tuple[float, float]]:
    """Deterministic energy-based VAD over 30 ms frames."""
    frame = int(rate * 0.03)
    if frame == 0 or samples.size < frame:
        return []
    usable = samples[: samples.size - samples.size % frame].reshape(-1, frame)
    energy = np.sqrt((usable**2).mean(axis=1))
    noise_floor = float(np.percentile(energy, 20))
    threshold = max(noise_floor * 3.0, 0.006)
    voiced = energy > threshold

    segments: list[tuple[float, float]] = []
    start: int | None = None
    silence = 0
    max_silence = 10  # 300 ms bridges natural pauses
    for index, active in enumerate(voiced):
        if active:
            if start is None:
                start = index
            silence = 0
        elif start is not None:
            silence += 1
            if silence >= max_silence:
                segments.append((start * 0.03, (index - silence) * 0.03))
                start = None
    if start is not None:
        segments.append((start * 0.03, len(voiced) * 0.03))
    return [(round(s, 2), round(e, 2)) for s, e in segments if e - s >= 0.25]


def transcribe(path: Path) -> tuple[list[dict[str, Any]], str, list[str]]:
    module = optional_module("faster_whisper")
    if module is None:
        raise EngineUnavailable(
            "Speech recognition is unavailable: install 'faster-whisper' (see apps/ai/requirements-optional.txt)"
        )
    cfg = settings()
    device = resolve_device()
    compute = "float16" if device == "cuda" else "int8"
    model = module.WhisperModel(cfg.whisper_model, device="cuda" if device == "cuda" else "cpu", compute_type=compute)
    segments, info = model.transcribe(str(path), vad_filter=True, word_timestamps=False)
    rows = [
        {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()}
        for seg in segments
        if seg.text.strip()
    ]
    warnings = [] if rows else ["No speech was recognised in this recording"]
    return rows, info.language, warnings


class AudioEngine(Engine):
    name = "audio"
    version = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        if not ffmpeg_available():
            return False, "ffmpeg is not installed"
        if optional_module("faster_whisper") is None:
            return True, "preprocessing + VAD ready; transcription disabled (faster-whisper missing)"
        return True, f"preprocessing + transcription ready on {resolve_device()}"

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        if not ffmpeg_available():
            raise EngineUnavailable("Audio processing is unavailable: ffmpeg is not installed on this worker")

        warnings: list[str] = []
        with download(request.fileUrl, suffix_for(request.originalName)) as source:
            duration = probe_duration(source)
            with tempfile.TemporaryDirectory() as workdir:
                working = Path(workdir) / "normalised.wav"
                preprocess(source, working)
                samples = read_wav(working)
                speech = voice_activity(samples)
                try:
                    transcript_segments, language, transcribe_warnings = transcribe(working)
                    warnings += transcribe_warnings
                except EngineUnavailable as exc:
                    transcript_segments, language = [], None
                    warnings.append(str(exc.detail))

        duration = duration or round(len(samples) / TARGET_RATE, 2)
        segments = transcript_segments or [{"start": s, "end": e, "text": None} for s, e in speech]

        rows = [
            CompilationRow(
                rowKey=f"{request.fileReference}:{index + 1:04d}",
                data={
                    "Recording": request.originalName,
                    "Segment": index + 1,
                    # Speaker identity is never asserted without diarisation evidence.
                    "Speaker": "Unidentified",
                    "Start": segment["start"],
                    "End": segment["end"],
                    "Duration": round(segment["end"] - segment["start"], 2),
                    "Transcript": segment.get("text"),
                },
            )
            for index, segment in enumerate(segments)
        ]

        summary: dict[str, Any] = {
            "Recording": request.originalName,
            "Duration (s)": duration,
            "Language": language,
            "Speech segments": len(speech),
            "Transcribed segments": len(transcript_segments),
            "Speech ratio": round(sum(e - s for s, e in speech) / duration, 3) if duration else None,
            "Transcript": " ".join(seg["text"] for seg in transcript_segments if seg.get("text")) or None,
            "Segments": segments,
        }
        measurements = [
            {
                "subject": request.originalName,
                "parameter": "duration",
                "value": duration,
                "unit": "s",
                "status": "MEASURED",
                "method": "ffprobe/pcm-length",
                "source": "audio",
            }
        ]
        return self.output(
            summary=summary, columns=COLUMNS, rows=rows, measurements=measurements, warnings=warnings
        )

    def demo(self, request: ProcessRequest) -> ProcessingOutput:
        row = CompilationRow(
            rowKey=f"{request.fileReference}:0001",
            data={
                "Recording": request.originalName,
                "Segment": 1,
                "Speaker": "Unidentified",
                "Start": 0,
                "End": 0,
                "Duration": 0,
                "Transcript": "DEMO MODE — no transcription was performed",
            },
        )
        return self.output(
            summary={"Recording": request.originalName, "Note": "DEMO MODE"},
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: synthetic result"],
            demo=True,
        )
