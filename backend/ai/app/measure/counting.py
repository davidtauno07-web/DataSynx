"""Deduplicated counting from tracked identities.

Counting frame detections would count the same object once per frame. Every
count here is over tracked identities instead, so an object that stays in view
for a thousand frames is still one object.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

BUCKET_SECONDS = 60.0


@dataclass(frozen=True)
class CountedTrack:
    subject: str
    label: str
    start: float
    end: float
    zones: list[str] = field(default_factory=list)
    crossings: list[str] = field(default_factory=list)


def _tally(values: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for value in values:
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items()))


def count_summary(
    tracks: list[CountedTrack],
    bucket_seconds: float = BUCKET_SECONDS,
    tracking_quality: str | None = None,
) -> dict[str, Any]:
    """Unique object counts overall, per type, per zone, per line and over time."""
    if not tracks:
        return {
            "uniqueObjects": 0,
            "byType": {},
            "byZone": {},
            "lineCrossings": {},
            "overTime": [],
            "method": "unique tracked identities (no objects tracked)",
            "quality": tracking_quality,
        }

    by_zone: dict[str, set[str]] = {}
    for track in tracks:
        for zone in set(track.zones):
            by_zone.setdefault(zone, set()).add(track.subject)

    buckets: list[dict[str, Any]] = []
    if bucket_seconds > 0:
        start = min(t.start for t in tracks)
        end = max(t.end for t in tracks)
        edge = start
        while edge < end + 1e-9:
            stop = edge + bucket_seconds
            present = [t for t in tracks if t.start < stop and t.end >= edge]
            buckets.append(
                {
                    "from": round(edge, 2),
                    "to": round(stop, 2),
                    "unique": len(present),
                    "byType": _tally([t.label for t in present]),
                }
            )
            edge = stop

    return {
        "uniqueObjects": len(tracks),
        "byType": _tally([t.label for t in tracks]),
        "byZone": {zone: len(subjects) for zone, subjects in sorted(by_zone.items())},
        "lineCrossings": _tally([line for t in tracks for line in t.crossings]),
        "overTime": buckets,
        "method": "unique tracked identities, deduplicated across frames",
        "quality": tracking_quality,
    }


__all__ = ["BUCKET_SECONDS", "CountedTrack", "count_summary"]
