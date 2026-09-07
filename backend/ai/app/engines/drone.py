"""Drone engine: metadata → detection → geospatial measurement.

Geospatial values require real telemetry (GPS + altitude + camera intrinsics).
Missing telemetry is reported as UNAVAILABLE — never inferred.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..download import download, suffix_for
from ..measure import geo
from ..schemas import CompilationRow, Measurement, ProcessingOutput, ProcessRequest
from .base import Engine, optional_module
from .vision import detector_availability, get_detector

COLUMNS = [
    "Object",
    "Type",
    "Latitude",
    "Longitude",
    "Altitude",
    "Area",
    "Perimeter",
    "Width",
    "Length",
    "Confidence",
    "Source",
]

GPS_KEYS = {
    "lat": "GPS GPSLatitude",
    "lat_ref": "GPS GPSLatitudeRef",
    "lon": "GPS GPSLongitude",
    "lon_ref": "GPS GPSLongitudeRef",
    "alt": "GPS GPSAltitude",
    "alt_ref": "GPS GPSAltitudeRef",
}


def _ratio(value: Any) -> float:
    return float(value.num) / float(value.den) if getattr(value, "den", 0) else float(value)


# EXIF FocalPlaneResolutionUnit → millimetres per unit.
_RESOLUTION_UNIT_MM = {2: 25.4, 3: 10.0, 4: 1.0}


def _sensor_width_mm(tags: dict[str, Any], image_width_px: float | None) -> float | None:
    """Sensor width from EXIF focal-plane resolution: pixels / (pixels per unit) × mm per unit."""
    resolution_tag = tags.get("EXIF FocalPlaneXResolution")
    unit_tag = tags.get("EXIF FocalPlaneResolutionUnit")
    if resolution_tag is None or unit_tag is None or not image_width_px:
        return None
    try:
        pixels_per_unit = _ratio(resolution_tag.values[0])
        mm_per_unit = _RESOLUTION_UNIT_MM.get(int(unit_tag.values[0]))
    except (AttributeError, IndexError, TypeError, ValueError):
        return None
    if mm_per_unit is None or pixels_per_unit <= 0:
        return None
    return round(float(image_width_px) / pixels_per_unit * mm_per_unit, 4)


def read_metadata(path: Path) -> dict[str, Any]:
    """EXIF/XMP metadata; absent values stay absent."""
    exifread = optional_module("exifread")
    if exifread is None:
        return {}
    with path.open("rb") as handle:
        tags = exifread.process_file(handle, details=False)
    if not tags:
        return {}

    meta: dict[str, Any] = {}

    def dms(key: str, ref_key: str) -> float | None:
        tag = tags.get(GPS_KEYS[key])
        ref = tags.get(GPS_KEYS[ref_key])
        if tag is None:
            return None
        d, m, s = (_ratio(v) for v in tag.values)
        value = d + m / 60 + s / 3600
        if ref is not None and str(ref.values).upper() in {"S", "W"}:
            value = -value
        return round(value, 8)

    meta["latitude"] = dms("lat", "lat_ref")
    meta["longitude"] = dms("lon", "lon_ref")
    if GPS_KEYS["alt"] in tags:
        altitude = _ratio(tags[GPS_KEYS["alt"]].values[0])
        if str(tags.get(GPS_KEYS["alt_ref"], "0")) == "1":
            altitude = -altitude
        meta["altitude"] = round(altitude, 3)
    for label, tag in (
        ("timestamp", "EXIF DateTimeOriginal"),
        ("make", "Image Make"),
        ("model", "Image Model"),
        ("focalLengthMm", "EXIF FocalLength"),
        ("imageWidth", "EXIF ExifImageWidth"),
        ("imageHeight", "EXIF ExifImageLength"),
        ("gpsDirection", "GPS GPSImgDirection"),
        ("groundSpeed", "GPS GPSSpeed"),
    ):
        if tag in tags:
            raw = tags[tag]
            try:
                meta[label] = _ratio(raw.values[0]) if hasattr(raw.values[0], "den") else str(raw)
            except (AttributeError, IndexError, TypeError):
                meta[label] = str(raw)

    sensor_width = _sensor_width_mm(tags, meta.get("imageWidth"))
    if sensor_width is not None:
        meta["sensorWidthMm"] = sensor_width
    return {k: v for k, v in meta.items() if v is not None}


def measurement(
    subject: str, parameter: str, value: float | None, unit: str, method: str, reason: str | None = None
) -> Measurement:
    return Measurement(
        subject=subject,
        parameter=parameter,
        value=value,
        unit=unit if value is not None else None,
        status="MEASURED" if value is not None else "UNAVAILABLE",
        method=method if value is not None else None,
        source="drone",
        reason=reason if value is None else None,
    )


class DroneEngine(Engine):
    name = "drone"
    version = "1.0.0"

    def availability(self) -> tuple[bool, str]:
        ok, detail = detector_availability()
        return True, f"metadata + geospatial ready; detection: {detail if not ok else 'ready'}"

    def run(self, request: ProcessRequest) -> ProcessingOutput:
        options = request.options or {}
        warnings: list[str] = []

        with download(request.fileUrl, suffix_for(request.originalName)) as path:
            metadata = read_metadata(path)
            detections: list[Any] = []
            try:
                detections = get_detector().detect_image(path, options.get("classes"))
            except Exception as exc:  # EngineUnavailable or model failure
                warnings.append(getattr(exc, "detail", str(exc)))

        latitude = metadata.get("latitude")
        longitude = metadata.get("longitude")
        altitude = options.get("altitudeM", metadata.get("altitude"))
        sensor_width = options.get("sensorWidthMm", metadata.get("sensorWidthMm"))
        focal_length = options.get("focalLengthMm", metadata.get("focalLengthMm"))
        image_width = options.get("imageWidthPx", metadata.get("imageWidth"))

        gsd: float | None = None
        if all(isinstance(v, (int, float)) for v in (altitude, sensor_width, focal_length, image_width)):
            try:
                gsd = geo.ground_sample_distance(
                    float(altitude), float(sensor_width), float(focal_length), int(image_width)
                )
            except ValueError as exc:
                warnings.append(f"Ground sample distance could not be computed: {exc}")
        else:
            warnings.append(
                "Ground sample distance is unavailable (needs altitude, sensor width, focal length and image width): "
                "areas, perimeters and dimensions are reported as unavailable."
            )
        if latitude is None or longitude is None:
            warnings.append("No GPS metadata was present in this file: coordinates are reported as unavailable.")

        rows: list[CompilationRow] = []
        measurements: list[Measurement] = []
        counts: dict[str, int] = {}

        for index, detection in enumerate(detections, start=1):
            name = f"{detection.label.title()} #{index:03d}"
            counts[detection.label] = counts.get(detection.label, 0) + 1
            x1, y1, x2, y2 = detection.box
            width_px, height_px = abs(x2 - x1), abs(y2 - y1)

            width_m = round(width_px * gsd, 3) if gsd else None
            length_m = round(height_px * gsd, 3) if gsd else None
            area = round(width_m * length_m, 3) if width_m and length_m else None
            perimeter = round(2 * (width_m + length_m), 3) if width_m and length_m else None
            no_gsd = "Ground sample distance is unavailable"

            measurements += [
                measurement(name, "width", width_m, "m", "gsd × pixels", no_gsd),
                measurement(name, "length", length_m, "m", "gsd × pixels", no_gsd),
                measurement(name, "area", area, "m²", "bounding-box footprint × gsd²", no_gsd),
                measurement(name, "perimeter", perimeter, "m", "bounding-box perimeter × gsd", no_gsd),
            ]

            rows.append(
                CompilationRow(
                    rowKey=f"{request.fileReference}:{index:04d}",
                    data={
                        "Object": name,
                        "Type": detection.label,
                        "Latitude": latitude,
                        "Longitude": longitude,
                        "Altitude": altitude,
                        "Area": area,
                        "Perimeter": perimeter,
                        "Width": width_m,
                        "Length": length_m,
                        "Confidence": round(detection.confidence, 3),
                        "Source": request.originalName,
                    },
                    geometry={"type": "Point", "coordinates": [longitude, latitude]}
                    if latitude is not None and longitude is not None
                    else None,
                )
            )

        if not rows:
            rows.append(
                CompilationRow(
                    rowKey=f"{request.fileReference}:capture",
                    data={
                        "Object": "Capture",
                        "Type": "image",
                        "Latitude": latitude,
                        "Longitude": longitude,
                        "Altitude": altitude,
                        "Area": None,
                        "Perimeter": None,
                        "Width": None,
                        "Length": None,
                        "Confidence": None,
                        "Source": request.originalName,
                    },
                    geometry={"type": "Point", "coordinates": [longitude, latitude]}
                    if latitude is not None and longitude is not None
                    else None,
                )
            )

        summary: dict[str, Any] = {
            "Capture": request.originalName,
            "Latitude": latitude,
            "Longitude": longitude,
            "Altitude (m)": altitude,
            "Captured at": metadata.get("timestamp"),
            "Camera": " ".join(str(metadata.get(k, "")) for k in ("make", "model")).strip() or None,
            "Camera direction": metadata.get("gpsDirection"),
            "Ground sample distance (m/px)": round(gsd, 5) if gsd else None,
            "Detected objects": len(detections),
            "Counts by class": counts,
            "Metadata": metadata,
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
            summary={"Capture": request.originalName, "Note": "DEMO MODE — no drone data was analysed"},
            columns=COLUMNS,
            rows=[row],
            warnings=["DEMO MODE: synthetic result"],
            demo=True,
        )
