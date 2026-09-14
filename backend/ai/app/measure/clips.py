"""Contextual event clip planning.

A clip is never invented: every window here is anchored on events that came out
of tracking, and the window is only padded with the footage that surrounds
them. A long-running object therefore yields a chronological sequence of short
clips (one per burst of activity) rather than one multi-hour recording.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .events import ENTRY, EXIT, TrackEvent

PRE_SECONDS = 3.0
POST_SECONDS = 3.0
# Events further apart than this belong to separate clips.
GROUP_GAP_SECONDS = 6.0
# Hard ceiling per clip; a longer burst is split into consecutive clips.
MAX_CLIP_SECONDS = 30.0
MIN_CLIP_SECONDS = 1.0


@dataclass(frozen=True)
class ClipPlan:
    """One contextual clip: pre-event padding, the events, post-event padding."""

    clipKey: str
    subject: str
    objectType: str
    sequence: int
    startTime: float
    endTime: float
    eventTime: float
    kinds: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    reason: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "clipKey": self.clipKey,
            "subject": self.subject,
            "objectType": self.objectType,
            "sequence": self.sequence,
            "startTime": round(self.startTime, 2),
            "endTime": round(self.endTime, 2),
            "eventTime": round(self.eventTime, 2),
            "durationSeconds": round(self.endTime - self.startTime, 2),
            "kinds": self.kinds,
            "events": self.events,
            "reason": self.reason,
        }


def _group(events: list[TrackEvent]) -> list[list[TrackEvent]]:
    groups: list[list[TrackEvent]] = []
    for event in sorted(events, key=lambda e: e.time):
        if (
            groups
            and event.time - groups[-1][-1].time <= GROUP_GAP_SECONDS
            and event.time - groups[-1][0].time <= MAX_CLIP_SECONDS
        ):
            groups[-1].append(event)
        else:
            groups.append([event])
    return groups


def plan_clips(
    events: list[TrackEvent],
    duration: float | None = None,
    include_presence: bool = False,
) -> list[ClipPlan]:
    """Plans one clip per burst of events, chronologically, per tracked object.

    `duration` clamps the windows to the real footage length when it is known;
    without it the windows are only clamped at zero.
    """
    wanted = [
        event
        for event in events
        if include_presence or event.kind not in {ENTRY, EXIT}
    ]
    by_subject: dict[str, list[TrackEvent]] = {}
    for event in wanted:
        by_subject.setdefault(event.subject, []).append(event)

    plans: list[ClipPlan] = []
    for subject, subject_events in by_subject.items():
        for index, group in enumerate(_group(subject_events), start=1):
            first, last = group[0], group[-1]
            start = max(0.0, first.time - PRE_SECONDS)
            end = last.time + POST_SECONDS
            if duration is not None and duration > 0:
                end = min(end, duration)
            if end - start < MIN_CLIP_SECONDS:
                end = start + MIN_CLIP_SECONDS
                if duration is not None and duration > 0:
                    end = min(end, duration)
                    start = max(0.0, min(start, end - MIN_CLIP_SECONDS))
            kinds = sorted({event.kind for event in group})
            slug = subject.lower().replace(" ", "-").replace("#", "")
            plans.append(
                ClipPlan(
                    clipKey=f"{slug}-{index:02d}",
                    subject=subject,
                    objectType=first.objectType,
                    sequence=index,
                    startTime=start,
                    endTime=end,
                    eventTime=first.time,
                    kinds=kinds,
                    events=[event.as_dict() for event in group],
                    reason=", ".join(event.detail for event in group),
                )
            )

    plans.sort(key=lambda plan: (plan.startTime, plan.subject))
    return plans


__all__ = [
    "GROUP_GAP_SECONDS",
    "MAX_CLIP_SECONDS",
    "POST_SECONDS",
    "PRE_SECONDS",
    "ClipPlan",
    "plan_clips",
]
