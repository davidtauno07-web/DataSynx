"""Deterministic measurement engine tests (distance, area, perimeter, speed, CRS)."""

from __future__ import annotations

import math

import pytest

from app.errors import EngineFailed
from app.measure import geo
from app.measure.kinematics import (
    CalibrationError,
    direction_degrees,
    load_calibration,
    speed,
    to_world,
    track_distance,
)
from app.measure_ops import run_operation

TALLINN = (24.7536, 59.4370)
HELSINKI = (24.9384, 60.1699)


def test_geodesic_distance_matches_known_value() -> None:
    distance = geo.geodesic_distance(TALLINN, HELSINKI)
    assert 81_000 < distance < 83_000
    assert abs(distance - geo.haversine(TALLINN, HELSINKI)) < 300


def test_bearing_and_compass_point_north() -> None:
    degrees = geo.bearing(TALLINN, HELSINKI)
    assert 0 <= degrees < 30
    assert geo.compass_direction(degrees).startswith("N")


def test_polygon_area_and_perimeter_of_100m_square() -> None:
    lat, lon = 59.4370, 24.7536
    d_lat = 100 / 111_320
    d_lon = 100 / (111_320 * math.cos(math.radians(lat)))
    ring = [(lon, lat), (lon + d_lon, lat), (lon + d_lon, lat + d_lat), (lon, lat + d_lat)]
    area, perimeter = geo.polygon_area_perimeter(ring)
    assert area == pytest.approx(10_000, rel=0.01)
    assert perimeter == pytest.approx(400, rel=0.01)


def test_polygon_requires_three_points() -> None:
    with pytest.raises(ValueError):
        geo.polygon_area_perimeter([(0, 0), (1, 1)])


def test_coordinate_transformation_roundtrip() -> None:
    utm = geo.transform_coordinates([TALLINN], "EPSG:4326", "EPSG:32635")
    back = geo.transform_coordinates(utm, "EPSG:32635", "EPSG:4326")
    assert back[0][0] == pytest.approx(TALLINN[0], abs=1e-6)
    assert back[0][1] == pytest.approx(TALLINN[1], abs=1e-6)


def test_ground_sample_distance() -> None:
    gsd = geo.ground_sample_distance(altitude_m=100, sensor_width_mm=13.2, focal_length_mm=8.8, image_width_px=4000)
    assert gsd == pytest.approx(0.0375, rel=1e-3)


def test_speed_from_distance_and_time() -> None:
    assert speed(37.4, 12.0) == pytest.approx(3.1167, rel=1e-3)
    with pytest.raises(ValueError):
        speed(10, 0)


def test_uniform_scale_calibration_measures_track() -> None:
    calibration = load_calibration({"metresPerPixel": 0.05})
    distance = track_distance(calibration, [(0, 0), (100, 0), (100, 100)])
    assert distance == pytest.approx(10.0, rel=1e-6)


def test_homography_calibration_maps_square_to_ground_plane() -> None:
    calibration = load_calibration(
        {
            "points": [
                {"x": 0, "y": 0, "worldX": 0, "worldY": 0},
                {"x": 100, "y": 0, "worldX": 10, "worldY": 0},
                {"x": 100, "y": 100, "worldX": 10, "worldY": 10},
                {"x": 0, "y": 100, "worldX": 0, "worldY": 10},
            ]
        }
    )
    x, y = to_world(calibration, (50, 50))
    assert (x, y) == pytest.approx((5.0, 5.0), abs=1e-6)


def test_missing_calibration_is_unavailable_not_guessed() -> None:
    calibration = load_calibration(None)
    assert not calibration.available
    with pytest.raises(CalibrationError):
        to_world(calibration, (10, 10))

    result = run_operation("speed", {"pixels": [[0, 0], [10, 10]], "seconds": 2})
    assert result["status"] == "UNAVAILABLE"
    assert result["value"] is None


def test_insufficient_reference_points_rejected() -> None:
    with pytest.raises(CalibrationError):
        load_calibration({"points": [{"x": 0, "y": 0, "worldX": 0, "worldY": 0}]})


def test_direction_degrees_uses_screen_space_north() -> None:
    assert direction_degrees((0, 100), (0, 0)) == pytest.approx(0.0)
    assert direction_degrees((0, 0), (10, 0)) == pytest.approx(90.0)


def test_measure_operations_endpoint_surface() -> None:
    distance = run_operation("distance", {"from": TALLINN, "to": HELSINKI})
    assert distance["status"] == "MEASURED" and distance["unit"] == "m"

    route = run_operation("route_length", {"points": [TALLINN, HELSINKI, TALLINN]})
    assert route["value"] == pytest.approx(2 * distance["value"], rel=1e-6)

    with pytest.raises(EngineFailed):
        run_operation("teleport", {})


def test_offset_coordinate_projects_local_metres_onto_wgs84() -> None:
    origin = TALLINN
    north = geo.offset_coordinate(origin, 0, 100)
    assert geo.geodesic_distance(origin, north) == pytest.approx(100, abs=0.5)
    assert geo.bearing(origin, north) == pytest.approx(0, abs=0.5)

    east = geo.offset_coordinate(origin, 100, 0)
    assert geo.bearing(origin, east) == pytest.approx(90, abs=0.5)

    rotated = geo.offset_coordinate(origin, 0, 100, heading_deg=90)
    assert geo.bearing(origin, rotated) == pytest.approx(90, abs=0.5)
    assert geo.offset_coordinate(origin, 0, 0) == origin
