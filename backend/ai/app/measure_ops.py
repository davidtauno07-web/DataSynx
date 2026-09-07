"""Deterministic measurement operations exposed at POST /v1/measure.

These are pure mathematics: the command assistant and engines call them so no
model is ever asked to compute a physical quantity.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .errors import EngineFailed
from .measure import geo
from .measure.kinematics import Calibration, load_calibration, speed, track_distance


def _distance(params: dict[str, Any]) -> dict[str, Any]:
    value = geo.geodesic_distance(params["from"], params["to"])
    return {
        "parameter": "distance",
        "value": round(value, 3),
        "unit": "m",
        "status": "MEASURED",
        "method": "WGS84 geodesic (pyproj)",
        "crossCheckHaversineM": round(geo.haversine(params["from"], params["to"]), 3),
    }


def _bearing(params: dict[str, Any]) -> dict[str, Any]:
    degrees = geo.bearing(params["from"], params["to"])
    return {
        "parameter": "direction",
        "value": round(degrees, 2),
        "unit": "deg",
        "status": "MEASURED",
        "method": "WGS84 forward azimuth",
        "compass": geo.compass_direction(degrees),
    }


def _area(params: dict[str, Any]) -> dict[str, Any]:
    area, perimeter = geo.polygon_area_perimeter(params["ring"])
    return {
        "parameter": "area",
        "value": round(area, 3),
        "unit": "m2",
        "status": "MEASURED",
        "method": "WGS84 geodesic polygon",
        "perimeterM": round(perimeter, 3),
    }


def _perimeter(params: dict[str, Any]) -> dict[str, Any]:
    _area_m2, perimeter = geo.polygon_area_perimeter(params["ring"])
    return {
        "parameter": "perimeter",
        "value": round(perimeter, 3),
        "unit": "m",
        "status": "MEASURED",
        "method": "WGS84 geodesic polygon",
    }


def _route(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "parameter": "route_length",
        "value": round(geo.path_length(params["points"]), 3),
        "unit": "m",
        "status": "MEASURED",
        "method": "WGS84 geodesic path",
    }


def _speed(params: dict[str, Any]) -> dict[str, Any]:
    seconds = float(params["seconds"])
    if "from" in params and "to" in params:
        distance = geo.geodesic_distance(params["from"], params["to"])
        method = "geodesic distance / time"
    elif "pixels" in params:
        calibration: Calibration = load_calibration(params.get("calibration"))
        if not calibration.available:
            return {
                "parameter": "speed",
                "value": None,
                "unit": None,
                "status": "UNAVAILABLE",
                "reason": "Camera calibration is required to convert pixel motion to metres",
            }
        distance = track_distance(calibration, [(float(p[0]), float(p[1])) for p in params["pixels"]])
        method = "calibrated pixel track / time"
    else:
        distance = float(params["distanceM"])
        method = "distance / time"

    value = speed(distance, seconds)
    return {
        "parameter": "speed",
        "value": round(value, 3),
        "unit": "m/s",
        "status": "MEASURED",
        "method": method,
        "distanceM": round(distance, 3),
        "kmh": round(value * 3.6, 2),
    }


def _transform(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "parameter": "coordinates",
        "status": "MEASURED",
        "method": f"{params['from']} → {params['to']}",
        "points": geo.transform_coordinates(params["points"], params["from"], params["to"]),
    }


def _gsd(params: dict[str, Any]) -> dict[str, Any]:
    value = geo.ground_sample_distance(
        float(params["altitudeM"]),
        float(params["sensorWidthMm"]),
        float(params["focalLengthMm"]),
        int(params["imageWidthPx"]),
    )
    return {
        "parameter": "ground_sample_distance",
        "value": round(value, 6),
        "unit": "m/px",
        "status": "MEASURED",
        "method": "altitude × sensor width / (focal length × image width)",
    }


OPERATIONS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "distance": _distance,
    "bearing": _bearing,
    "area": _area,
    "perimeter": _perimeter,
    "route_length": _route,
    "speed": _speed,
    "transform_coordinates": _transform,
    "ground_sample_distance": _gsd,
}


def run_operation(operation: str, params: dict[str, Any]) -> dict[str, Any]:
    handler = OPERATIONS.get(operation)
    if handler is None:
        raise EngineFailed(f"Unsupported measurement operation '{operation}'")
    try:
        return handler(params)
    except EngineFailed:
        raise
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise EngineFailed(f"Measurement '{operation}' could not be computed: {exc}") from exc
