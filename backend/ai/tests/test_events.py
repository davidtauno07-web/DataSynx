"""CCTV event derivation tests: events only exist when the tracking shows them."""

from __future__ import annotations

from app.measure.events import (
    DIRECTION_CHANGE,
    ENTRY,
    EXIT,
    LINE_CROSSING,
    STOP,
    ZONE_ENTRY,
    ZONE_EXIT,
    important_moments,
    occupancy_timeline,
    peak_occupancy,
    track_events,
)

BOX = (0.0, 0.0, 20.0, 20.0)


def samples(points: list[tuple[float, float]], step: float = 1.0):
    return [(index * step, point, BOX) for index, point in enumerate(points)]


def kinds(events) -> list[str]:
    return [event.kind for event in events]


def test_entry_and_exit_are_always_derived() -> None:
    events = track_events("Person #001", "person", samples([(0, 0), (100, 0)]))
    assert kinds(events)[0] == ENTRY
    assert kinds(events)[-1] == EXIT


def test_line_crossing_is_recorded_with_its_time() -> None:
    line = {"name": "Doorway", "x1": 50, "y1": -100, "x2": 50, "y2": 100}
    events = track_events("Person #001", "person", samples([(0, 0), (40, 0), (60, 0)]), [line])
    crossing = next(event for event in events if event.kind == LINE_CROSSING)
    assert crossing.time == 2.0
    assert crossing.evidence["line"] == "Doorway"


def test_zone_entry_and_exit_follow_the_trajectory() -> None:
    zone = {"name": "Till", "x1": 40, "y1": -10, "x2": 80, "y2": 10}
    events = track_events("Person #001", "person", samples([(0, 0), (50, 0), (120, 0)]), [], [zone])
    assert ZONE_ENTRY in kinds(events)
    assert ZONE_EXIT in kinds(events)


def test_stationary_object_produces_a_stop_event() -> None:
    events = track_events("Person #001", "person", samples([(0, 0), (0, 0), (0, 0), (0, 0)]))
    stop = next(event for event in events if event.kind == STOP)
    assert stop.evidence["seconds"] >= 1.0


def test_steady_movement_has_no_stop_or_direction_change() -> None:
    events = track_events("Vehicle #001", "car", samples([(0, 0), (100, 0), (200, 0), (300, 0)]))
    assert STOP not in kinds(events)
    assert DIRECTION_CHANGE not in kinds(events)


def test_turn_produces_a_direction_change() -> None:
    events = track_events("Vehicle #001", "car", samples([(0, 0), (100, 0), (100, 100)]))
    turn = next(event for event in events if event.kind == DIRECTION_CHANGE)
    assert turn.evidence["fromDeg"] != turn.evidence["toDeg"]


def test_important_moments_exclude_plain_presence() -> None:
    line = {"name": "Doorway", "x1": 50, "y1": -100, "x2": 50, "y2": 100}
    events = track_events("Person #001", "person", samples([(0, 0), (40, 0), (60, 0)]), [line])
    moments = important_moments(events)
    assert kinds(moments) == [LINE_CROSSING]


def test_occupancy_timeline_reports_the_real_peak() -> None:
    timeline = occupancy_timeline([("a", 0.0, 3.0), ("b", 2.0, 5.0), ("c", 2.0, 2.0)])
    peak = peak_occupancy(timeline)
    assert peak is not None
    assert peak["count"] == 3
    assert peak["t"] == 2.0


def test_empty_track_yields_no_events() -> None:
    assert track_events("Person #001", "person", []) == []
    assert occupancy_timeline([]) == []
    assert peak_occupancy([]) is None
