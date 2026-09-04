"""CCTV engine: detection → tracking → trajectories → deterministic measurements.

Speed and distance are only reported as MEASURED when the job supplies camera
calibration. Without it the measurement is explicitly UNAVAILABLE — pixel
motion is never presented as metres.
"""

from __future__ import annotations

import math
from typing import Any

from ..download import download, suffix_for
from ..errors import EngineUnavailable
from ..measure.kinematics import (
    Calibration,
    CalibrationError,
    compass,
    direction_degrees,
    load_calibration,
    speed,
    track_distance,
)
from ..schemas import CompilationRow, Measurement, ProcessingOutput, ProcessRequest
from .base import Engine
from .vision import Track, detector_availability, get_detector

COLUMNS = [
    "Object",
    "Type",
    "Entry time",
    "Exit time",
    "Duration",
    "Direction",
    "Distance",
    "Speed",
    "Dwell time",
    "Line crossings",
    "Zone",
    "Frames",
]

LABEL_PREFIX = {
    "person": "Person",
    "car": "Vehicle",
    "truck": "Vehicle",
    "bus": "Vehicle",
    "motorcycle": "Vehicle",
    "bicycle": "Cycle",
}


def object_name(track: Track, index: int) -> str:
    return f"{LABEL_PREFIX.get(track.label, track.label.title())} #{index:03d}"


def crossings(track: Track, lines: list[dict[str, Any]]) -> list[str]:
    """Counts configured line crossings using segment intersection (image space)."""

    def side(line: dict[str, Any], point: tuple[float, float]) -> float:
        x1, y1, x2, y2 = line["x1"], line["y1"], line["x2"], line["y2"]
        return (x2 - x1) * (point[1] - y1) - (y2 - y1) * (point[0] - x1)

    hits: list[str] = []
    points = [d.centroid for d in track.detections]
    for line in lines:
        for a, b in zip(points, points[1:], strict=False):
            if side(line, a) * side(line, b) < 0:
                hits.append(str(line.get("name", "line")))
                break
    return hits


def zone_of(track: Track, zones: list[dict[str, Any]]) -> str | None:
    """Names the zone containing the last known position (axis-aligned zones)."""
    x, y = track.last.centroid
    for zone in zones:
        if zone["x1"] <= x <= zone["x2"] and zone["y1"] <= y <= zone["y2"]:
            return str(zone.get("name", "zone"))
    return None


def pixel_path_length(track: Track) -> float:
    points = [d.centroid for d in track.detections]
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


class CCTVEngine(Engine):
    name = "cctv"
    version = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        return detector_availability()

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        options = request.options or {}
        calibration_spec = options.get("calibration")
        try:
            calibration = load_calibration(calibration_spec)
        except CalibrationError as exc:
            calibration = Calibration(None, None, "invalid")
            calibration_error: str | None = str(exc)
        else:
            calibration_error = None

        detector = get_detector()
        with download(request.fileUrl, suffix_for(request.originalName)) as path:
            tracks, meta = detector.track_video(path, options.get("classes"))

        warnings: list[str] = []
        if calibration_error:
            warnings.append(f"Calibration rejected: {calibration_error}")
        if not calibration.available:
            warnings.append(
                "No camera calibration was supplied: distance and speed are reported as unavailable "
                "(pixel motion cannot be converted to metres)."
            )
        if not meta["fps"]:
            warnings.append("Video frame rate could not be read; timings are frame-indexed only.")
        if not tracks:
            warnings.append("No tracked objects were detected in this footage.")

        lines = options.get("lines") or []
        zones = options.get("zones") or []

        rows: list[CompilationRow] = []
        measurements: list[Measurement] = []
        counts: dict[str, int] = {}
        trajectories: list[dict[str, Any]] = []

        for index, track in enumerate(tracks, start=1):
            name = object_name(track, index)
            counts[track.label] = counts.get(track.label, 0) + 1
            start, end = track.first.centroid, track.last.centroid
            heading = direction_degrees(start, end)
            duration = track.duration

            distance_m: float | None = None
            speed_ms: float | None = None
            if calibration.available:
                try:
                    distance_m = round(track_distance(calibration, [d.centroid for d in track.detections]), 2)
                    if duration > 0:
                        speed_ms = round(speed(distance_m, duration), 2)
                except (CalibrationError, ValueError) as exc:
                    warnings.append(f"{name}: measurement failed ({exc})")

            status = "MEASURED" if distance_m is not None else "UNAVAILABLE"
            reason = None if distance_m is not None else "Camera calibration is required to convert pixels to metres"
            measurements.append(
                Measurement(
                    subject=name,
                    parameter="distance",
                    value=distance_m,
                    unit="m" if distance_m is not None else None,
                    status=status,
                    method="homography"
                    if calibration.homography is not None
                    else ("uniform-scale" if calibration.metres_per_pixel else None),
                    source="tracking",
                    quality=calibration.quality,
                    reason=reason,
                )
            )
            measurements.append(
                Measurement(
                    subject=name,
                    parameter="speed",
                    value=speed_ms,
                    unit="m/s" if speed_ms is not None else None,
                    status="MEASURED" if speed_ms is not None else "UNAVAILABLE",
                    method="distance/time" if speed_ms is not None else None,
                    source="tracking",
                    quality=calibration.quality,
                    reason=None if speed_ms is not None else reason or "Track duration is unknown",
                )
            )
            measurements.append(
                Measurement(
                    subject=name,
                    parameter="direction",
                    value=round(heading, 1),
                    unit="deg",
                    status="MEASURED",
                    method="first-to-last centroid bearing",
                    source="tracking",
                )
            )

            line_hits = crossings(track, lines)
            trajectory = [
                {"t": round(d.timestamp, 2), "x": round(d.centroid[0], 1), "y": round(d.centroid[1], 1)}
                for d in track.detections
            ]
            trajectories.append({"object": name, "type": track.label, "points": trajectory})

            rows.append(
                CompilationRow(
                    rowKey=f"{request.fileReference}:{track.track_id}",
                    data={
                        "Object": name,
                        "Type": track.label,
                        "Entry time": round(track.first.timestamp, 2),
                        "Exit time": round(track.last.timestamp, 2),
                        "Duration": round(duration, 2),
                        "Direction": f"{compass(heading)} ({heading:.0f}°)",
                        "Distance": distance_m,
                        "Speed": speed_ms,
                        "Dwell time": round(duration, 2),
                        "Line crossings": ", ".join(line_hits) or None,
                        "Zone": zone_of(track, zones),
                        "Frames": len(track.detections),
                    },
                    geometry={
                        "type": "LineString",
                        "coordinates": [[p["x"], p["y"]] for p in trajectory],
                        "properties": {"space": "image-pixels", "object": name},
                    }
                    if len(trajectory) > 1
                    else None,
                )
            )

        summary: dict[str, Any] = {
            "Source": request.originalName,
            "Frames analysed": meta["frames"],
            "Frame rate": meta["fps"] or None,
            "Detector": meta["model"],
            "Device": meta["device"],
            "Tracked objects": len(tracks),
            "Counts by class": counts,
            "Calibration": calibration.quality if calibration.available else "unavailable",
            "Trajectories": trajectories,
        }
        return self.output(
            summary=summary, columns=COLUMNS, rows=rows, measurements=measurements, warnings=warnings
        )

    def demo(self, request: ProcessRequest) -> ProcessingOutput:
        row = CompilationRow(
            rowKey=f"{request.fileReference}:demo",
            data=dict.fromkeys(COLUMNS, None) | {"Object": "DEMO", "Type": "demo"},
        )
        return self.output(
            summary={"Source": request.originalName, "Note": "DEMO MODE — no video was analysed"},
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: synthetic result"],
            demo=True,
        )


def unavailable_engine_message() -> str:  # pragma: no cover - helper for callers
    ok, detail = detector_availability()
    return detail if not ok else ""


__all__ = ["CCTVEngine", "EngineUnavailable", "unavailable_engine_message"]
