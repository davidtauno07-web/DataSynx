"""Pixel→world transformation and speed/distance mathematics for CCTV."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np


class CalibrationError(ValueError):
    pass


@dataclass(frozen=True)
class Calibration:
    """Either a homography (image px → ground plane metres) or a uniform scale."""

    homography: np.ndarray | None
    metres_per_pixel: float | None
    quality: str

    @property
    def available(self) -> bool:
        return self.homography is not None or self.metres_per_pixel is not None


def load_calibration(spec: dict[str, Any] | None) -> Calibration:
    if not spec:
        return Calibration(None, None, "none")

    points = spec.get("points")
    if points:
        image_pts = np.array([[float(p["x"]), float(p["y"])] for p in points], dtype=np.float64)
        world_pts = np.array([[float(p["worldX"]), float(p["worldY"])] for p in points], dtype=np.float64)
        if len(points) < 4:
            raise CalibrationError("Homography calibration requires at least four reference points")
        return Calibration(_homography(image_pts, world_pts), None, spec.get("quality", "reference-points"))

    scale = spec.get("metresPerPixel")
    if scale:
        return Calibration(None, float(scale), spec.get("quality", "uniform-scale"))

    return Calibration(None, None, "none")


def _homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Direct linear transform; avoids a hard OpenCV dependency for calibration."""
    rows = []
    for (x, y), (u, v) in zip(src, dst, strict=True):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vh = np.linalg.svd(np.array(rows, dtype=np.float64))
    h = vh[-1].reshape(3, 3)
    if abs(h[2, 2]) < 1e-12:
        raise CalibrationError("Calibration reference points are degenerate")
    return h / h[2, 2]


def to_world(calibration: Calibration, point: tuple[float, float]) -> tuple[float, float]:
    if calibration.homography is not None:
        vec = calibration.homography @ np.array([point[0], point[1], 1.0])
        if abs(vec[2]) < 1e-12:
            raise CalibrationError("Point could not be projected onto the ground plane")
        return float(vec[0] / vec[2]), float(vec[1] / vec[2])
    if calibration.metres_per_pixel is not None:
        return point[0] * calibration.metres_per_pixel, point[1] * calibration.metres_per_pixel
    raise CalibrationError("No calibration available")


def track_distance(calibration: Calibration, points: list[tuple[float, float]]) -> float:
    world = [to_world(calibration, p) for p in points]
    return sum(math.dist(world[i], world[i + 1]) for i in range(len(world) - 1))


def speed(distance_m: float, seconds: float) -> float:
    if seconds <= 0:
        raise ValueError("Speed requires a positive time delta")
    return distance_m / seconds


def direction_degrees(start: tuple[float, float], end: tuple[float, float]) -> float:
    """Screen/ground bearing in degrees where 0° = north (negative y is up)."""
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    return (math.degrees(math.atan2(dx, -dy))) % 360.0


def compass(degrees: float) -> str:
    points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return points[int((degrees % 360) / 45 + 0.5) % 8]
