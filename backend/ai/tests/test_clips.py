from app.measure.clips import GROUP_GAP_SECONDS, POST_SECONDS, PRE_SECONDS, plan_clips
from app.measure.counting import CountedTrack, count_summary
from app.measure.events import (
    DIRECTION_CHANGE,
    ENTRY,
    EXIT,
    LINE_CROSSING,
    STOP,
    TrackEvent,
)


def event(time: float, kind: str, subject: str = "Person #001") -> TrackEvent:
    return TrackEvent(time, kind, subject, "person", f"{kind} at {time}")


def test_presence_only_track_produces_no_clip() -> None:
    assert plan_clips([event(0.0, ENTRY), event(9.0, EXIT)]) == []


def test_clip_pads_around_the_event_and_is_clamped_to_the_footage() -> None:
    clips = plan_clips([event(1.0, LINE_CROSSING)], duration=2.5)
    assert len(clips) == 1
    clip = clips[0]
    assert clip.startTime == 0.0
    assert clip.endTime == 2.5
    assert clip.kinds == [LINE_CROSSING]


def test_long_running_object_yields_a_chronological_clip_sequence() -> None:
    gap = GROUP_GAP_SECONDS + 5.0
    clips = plan_clips(
        [event(10.0, STOP), event(10.0 + gap, LINE_CROSSING), event(10.0 + 2 * gap, DIRECTION_CHANGE)],
        duration=600.0,
    )
    assert [clip.sequence for clip in clips] == [1, 2, 3]
    assert [clip.startTime for clip in clips] == sorted(clip.startTime for clip in clips)
    assert clips[0].endTime == 10.0 + POST_SECONDS
    assert clips[1].startTime == 10.0 + gap - PRE_SECONDS


def test_clips_are_grouped_per_subject() -> None:
    clips = plan_clips([event(4.0, STOP, "Person #001"), event(4.5, STOP, "Vehicle #002")], duration=60.0)
    assert {clip.subject for clip in clips} == {"Person #001", "Vehicle #002"}
    assert all(clip.sequence == 1 for clip in clips)


def test_counts_are_deduplicated_per_tracked_identity() -> None:
    tracks = [
        CountedTrack("Person #001", "person", 0.0, 30.0, zones=["Forecourt"], crossings=["Gate"]),
        CountedTrack("Person #002", "person", 70.0, 90.0, zones=["Forecourt"]),
        CountedTrack("Vehicle #003", "car", 10.0, 20.0, crossings=["Gate"]),
    ]
    summary = count_summary(tracks, bucket_seconds=60.0)

    assert summary["uniqueObjects"] == 3
    assert summary["byType"] == {"car": 1, "person": 2}
    assert summary["byZone"] == {"Forecourt": 2}
    assert summary["lineCrossings"] == {"Gate": 2}
    assert [bucket["unique"] for bucket in summary["overTime"]] == [2, 1]


def test_empty_counts_report_zero_without_inventing_buckets() -> None:
    summary = count_summary([])
    assert summary["uniqueObjects"] == 0
    assert summary["overTime"] == []
