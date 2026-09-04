"""Deterministic geospatial mathematics. No model ever guesses these values."""

from __future__ import annotations

import math
from typing import Any

from pyproj import Geod, Transformer

GEOD = Geod(ellps="WGS84")

Coordinate = tuple[float, float]  # (longitude, latitude)


def _coord(value: Any) -> Coordinate:
    if isinstance(value, dict):
        lon = value.get("lon", value.get("longitude"))
        lat = value.get("lat", value.get("latitude"))
    else:
        lon, lat = value[0], value[1]
    if lon is None or lat is None:
        raise ValueError("Coordinate requires longitude and latitude")
    return float(lon), float(lat)


def geodesic_distance(a: Any, b: Any) -> float:
    """Great-ellipse distance in metres between two WGS84 coordinates."""
    (lon1, lat1), (lon2, lat2) = _coord(a), _coord(b)
    _, _, distance = GEOD.inv(lon1, lat1, lon2, lat2)
    return abs(distance)


def bearing(a: Any, b: Any) -> float:
    """Initial forward azimuth in degrees, normalised to [0, 360)."""
    (lon1, lat1), (lon2, lat2) = _coord(a), _coord(b)
    azimuth, _, _ = GEOD.inv(lon1, lat1, lon2, lat2)
    return azimuth % 360.0


def compass_direction(degrees: float) -> str:
    points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return points[int((degrees % 360) / 22.5 + 0.5) % 16]


def polygon_area_perimeter(ring: list[Any]) -> tuple[float, float]:
    """Returns (area m², perimeter m) for a WGS84 ring using geodesic maths."""
    coords = [_coord(point) for point in ring]
    if len(coords) < 3:
        raise ValueError("A polygon requires at least three coordinates")
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    area, perimeter = GEOD.polygon_area_perimeter(lons, lats)
    return abs(area), abs(perimeter)


def path_length(points: list[Any]) -> float:
    coords = [_coord(point) for point in points]
    return sum(geodesic_distance(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def transform_coordinates(points: list[Any], source_crs: str, target_crs: str) -> list[list[float]]:
    transformer = Transformer.from_crs(source_crs, target_crs, always_xy=True)
    out: list[list[float]] = []
    for point in points:
        x, y = _coord(point)
        tx, ty = transformer.transform(x, y)
        out.append([tx, ty])
    return out


def ground_sample_distance(
    altitude_m: float, sensor_width_mm: float, focal_length_mm: float, image_width_px: int
) -> float:
    """Metres per pixel for a nadir capture (classic photogrammetry GSD formula)."""
    if min(altitude_m, sensor_width_mm, focal_length_mm, image_width_px) <= 0:
        raise ValueError("GSD requires positive altitude, sensor width, focal length and image width")
    return (altitude_m * sensor_width_mm) / (focal_length_mm * image_width_px)


def haversine(a: Any, b: Any) -> float:
    """Spherical fallback, kept for cross-checking the ellipsoidal result."""
    (lon1, lat1), (lon2, lat2) = _coord(a), _coord(b)
    radius = 6_371_008.8
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))
