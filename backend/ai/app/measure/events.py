"""Evidence-based CCTV event derivation.

Every event here is derived from actual tracking output (detections, their
timestamps and their positions). Nothing is inferred when the underlying
evidence is missing: no calibration means no metric event thresholds, and an
event is only emitted when the tracked geometry actually shows it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

ENTRY = "ENTRY"
EXIT = "EXIT"
LINE_CROSSING = "LINE_CROSSING"
ZONE_ENTRY = "ZONE_ENTRY"
ZONE_EXIT = "ZONE_EXIT"
STOP = "STOP"
RESUME = "RESUME"
DIRECTION_CHANGE = "DIRECTION_CHANGE"

# Motion below this fraction of the object's own size per second is treated as
# stationary: it is comparable to detector jitter rather than travel.
STATIONARY_FRACTION = 0.15
MIN_STOP_SECONDS = 1.0
DIRECTION_CHANGE_DEGREES = 45.0


@dataclass(frozen=True)
class TrackEvent:
    time: float
    kind: str
    subject: str
    objectType: str
    detail: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "time": round(self.time, 2),
            "kind": self.kind,
            "subject": self.subject,
            "objectType": self.objectType,
            "detail": self.detail,
            "evidence": self.evidence,
        }


def _bearing(start: tuple[float, float], end: tuple[float, float]) -> float:
    return math.degrees(math.atan2(end[0] - start[0], -(end[1] - start[1]))) % 360.0


def _angle_delta(a: float, b: float) -> float:
    return abs((b - a + 180.0) % 360.0 - 180.0)


def _object_size(box: tuple[float, float, float, float]) -> float:
    x1, y1, x2, y2 = box
    return max(math.dist((x1, y1), (x2, y2)), 1.0)


def _zone_at(point: tuple[float, float], zones: list[dict[str, Any]]) -> str | None:
    for zone in zones:
        if zone["x1"] <= point[0] <= zone["x2"] and zone["y1"] <= point[1] <= zone["y2"]:
            return str(zone.get("name", "zone"))
    return None


def _side(line: dict[str, Any], point: tuple[float, float]) -> float:
    x1, y1, x2, y2 = line["x1"], line["y1"], line["x2"], line["y2"]
    return (x2 - x1) * (point[1] - y1) - (y2 - y1) * (point[0] - x1)


def track_events(
    subject: str,
    object_type: str,
    samples: list[tuple[float, tuple[float, float], tuple[float, float, float, float]]],
    lines: list[dict[str, Any]] | None = None,
    zones: list[dict[str, Any]] | None = None,
) -> list[TrackEvent]:
    """Derives the timeline of one track from its (time, centroid, box) samples."""
    if not samples:
        return []

    lines = lines or []
    zones = zones or []
    events: list[TrackEvent] = []

    first_t, first_p, _ = samples[0]
    last_t, last_p, _ = samples[-1]
    events.append(
        TrackEvent(
            first_t,
            ENTRY,
            subject,
            object_type,
            "First appearance in view",
            {"x": round(first_p[0], 1), "y": round(first_p[1], 1)},
        )
    )

    zone = _zone_at(first_p, zones)
    if zone:
        events.append(TrackEvent(first_t, ZONE_ENTRY, subject, object_type, f"Entered zone {zone}", {"zone": zone}))

    stopped_since: float | None = None
    previous_bearing: float | None = None
    reference_bearing: float | None = None

    for (t0, p0, b0), (t1, p1, _) in zip(samples, samples[1:], strict=False):
        dt = t1 - t0
        moved = math.dist(p0, p1)
        size = _object_size(b0)

        for line in lines:
            if _side(line, p0) * _side(line, p1) < 0:
                name = str(line.get("name", "line"))
                events.append(
                    TrackEvent(
                        t1,
                        LINE_CROSSING,
                        subject,
                        object_type,
                        f"Crossed {name}",
                        {"line": name, "x": round(p1[0], 1), "y": round(p1[1], 1)},
                    )
                )

        before, after = _zone_at(p0, zones), _zone_at(p1, zones)
        if before != after:
            if before:
                events.append(TrackEvent(t1, ZONE_EXIT, subject, object_type, f"Left zone {before}", {"zone": before}))
            if after:
                events.append(
                    TrackEvent(t1, ZONE_ENTRY, subject, object_type, f"Entered zone {after}", {"zone": after})
                )

        if dt > 0:
            stationary = (moved / dt) < (STATIONARY_FRACTION * size)
            if stationary:
                if stopped_since is None:
                    stopped_since = t0
            elif stopped_since is not None:
                held = t0 - stopped_since
                if held >= MIN_STOP_SECONDS:
                    events.append(
                        TrackEvent(
                            stopped_since,
                            STOP,
                            subject,
                            object_type,
                            f"Stationary for {held:.1f}s",
                            {"seconds": round(held, 2)},
                        )
                    )
                    events.append(TrackEvent(t0, RESUME, subject, object_type, "Started moving again", {}))
                stopped_since = None

        if moved >= 0.1 * size:
            bearing = _bearing(p0, p1)
            if reference_bearing is None:
                reference_bearing = bearing
            elif _angle_delta(reference_bearing, bearing) >= DIRECTION_CHANGE_DEGREES:
                events.append(
                    TrackEvent(
                        t1,
                        DIRECTION_CHANGE,
                        subject,
                        object_type,
                        f"Changed direction by {_angle_delta(reference_bearing, bearing):.0f}°",
                        {"fromDeg": round(reference_bearing, 1), "toDeg": round(bearing, 1)},
                    )
                )
                reference_bearing = bearing
            previous_bearing = bearing

    if stopped_since is not None:
        held = last_t - stopped_since
        if held >= MIN_STOP_SECONDS:
            events.append(
                TrackEvent(
                    stopped_since,
                    STOP,
                    subject,
                    object_type,
                    f"Stationary for {held:.1f}s",
                    {"seconds": round(held, 2)},
                )
            )

    events.append(
        TrackEvent(
            last_t,
            EXIT,
            subject,
            object_type,
            "Last appearance in view",
            {
                "x": round(last_p[0], 1),
                "y": round(last_p[1], 1),
                "bearingDeg": round(previous_bearing, 1) if previous_bearing is not None else None,
            },
        )
    )
    return sorted(events, key=lambda e: (e.time, e.kind))


IMPORTANT_KINDS = {LINE_CROSSING, ZONE_ENTRY, ZONE_EXIT, STOP, DIRECTION_CHANGE}


def important_moments(events: list[TrackEvent], limit: int = 20) -> list[TrackEvent]:
    """Selects the events that carry information beyond simple presence."""
    selected = [event for event in events if event.kind in IMPORTANT_KINDS]
    return sorted(selected, key=lambda e: e.time)[:limit]


def occupancy_timeline(
    intervals: list[tuple[str, float, float]], step: float = 1.0
) -> list[dict[str, Any]]:
    """Counts concurrently tracked objects over time from track intervals."""
    if not intervals or step <= 0:
        return []
    start = min(i[1] for i in intervals)
    end = max(i[2] for i in intervals)
    timeline: list[dict[str, Any]] = []
    t = start
    while t <= end + 1e-9:
        count = sum(1 for _, a, b in intervals if a <= t <= b)
        timeline.append({"t": round(t, 2), "count": count})
        t += step
    return timeline


def peak_occupancy(timeline: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not timeline:
        return None
    peak = max(timeline, key=lambda point: point["count"])
    return {"t": peak["t"], "count": peak["count"]}


__all__ = [
    "DIRECTION_CHANGE",
    "ENTRY",
    "EXIT",
    "LINE_CROSSING",
    "RESUME",
    "STOP",
    "ZONE_ENTRY",
    "ZONE_EXIT",
    "TrackEvent",
    "important_moments",
    "occupancy_timeline",
    "peak_occupancy",
    "track_events",
]
