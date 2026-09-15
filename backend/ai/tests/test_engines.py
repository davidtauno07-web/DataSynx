"""Engine tests: parsing, structuring, and honest unavailability."""

from __future__ import annotations

from pathlib import Path

import piexif
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.engines import ENGINES
from app.engines.audio import voice_activity
from app.engines.cctv import CCTVEngine
from app.engines.document import classify, extract_text
from app.engines.drone import read_metadata
from app.engines.email import extract_entities, strip_html
from app.engines.invoice import parse_amount, parse_date, rule_based_extract, validate
from app.engines.vision import Detection, Track
from app.main import app
from app.measure import geo
from app.measure.kinematics import load_calibration
from app.schemas import ProcessRequest

INVOICE_TEXT = """ACME Analytics OU
Invoice No: INV-2026-0042
Invoice date: 14/02/2026
Due date: 14/03/2026
Supplier: ACME Analytics OU
Customer: Northwind Ltd
Purchase Order: PO-99120

Description                 Qty   Unit price   Amount
Data processing hours       10    45.00        450.00
Storage (TB/month)          2     25.00        50.00

Subtotal: 500.00 EUR
VAT 22%: 110.00 EUR
Total: 610.00 EUR
IBAN: EE382200221020145685
"""

client = TestClient(app)
AUTH = {"authorization": "Bearer dev-ai-token"}


def write(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path


def test_invoice_amount_and_date_parsing() -> None:
    assert parse_amount("1 234,56 EUR") == 1234.56
    assert parse_amount("€1,234.56") == 1234.56
    assert parse_amount("no digits here") is None
    assert parse_date("14/02/2026") == "2026-02-14"
    assert parse_date("not a date") is None


def test_invoice_rule_based_extraction() -> None:
    fields = rule_based_extract(INVOICE_TEXT)
    assert fields["invoiceNumber"] == "INV-2026-0042"
    assert fields["invoiceDate"] == "2026-02-14"
    assert fields["dueDate"] == "2026-03-14"
    assert fields["customer"] == "Northwind Ltd"
    assert fields["currency"] == "EUR"
    assert fields["subtotal"] == 500.00
    assert fields["tax"] == 110.00
    assert fields["total"] == 610.00
    assert fields["purchaseOrder"] == "PO-99120"
    assert fields["iban"] == "EE382200221020145685"
    assert len(fields["lineItems"]) == 2
    assert fields["lineItems"][0]["amount"] == 450.00
    assert validate(fields) == []


def test_invoice_missing_fields_are_null_not_invented() -> None:
    fields = rule_based_extract("Just a note with no invoice data.")
    assert fields["invoiceNumber"] is None
    assert fields["total"] is None
    warnings = validate(fields)
    assert any("invoiceNumber" in w for w in warnings)


def test_invoice_totals_mismatch_is_warned_not_corrected() -> None:
    fields = rule_based_extract(INVOICE_TEXT.replace("Total: 610.00", "Total: 999.00"))
    assert fields["total"] == 999.00
    assert any("do not reconcile" in w for w in validate(fields))


def test_document_text_extraction_and_classification(tmp_path: Path) -> None:
    path = write(tmp_path, "note.txt", "This agreement is made between the parties hereby.")
    text, pages, warnings, source = extract_text(path, "text/plain", "note.txt")
    assert "agreement" in text and pages == 1 and source == "text" and warnings == []
    assert classify(text, "note.txt") == "contract"


def test_document_csv_extraction(tmp_path: Path) -> None:
    path = write(tmp_path, "rows.csv", "a,b\n1,2\n")
    text, _, _, source = extract_text(path, "text/csv", "rows.csv")
    assert source == "csv" and "1, 2" in text


def test_email_entities_and_html_stripping() -> None:
    text = strip_html("<p>Contact <b>ops@northwind.com</b> about €1 200,00</p><script>x</script>")
    assert "ops@northwind.com" in text and "script" not in text
    entities = extract_entities(text + " Northwind Ltd on 14/02/2026 https://example.com +372 5555 1234")
    assert "ops@northwind.com" in entities["emails"]
    assert "Northwind" in " ".join(entities["organizations"])
    assert "2026-02-14" in entities["dates"]
    assert entities["urls"] == ["https://example.com"]


def test_email_engine_structures_selected_message() -> None:
    request = ProcessRequest(
        fileReference="DSX-2026-000001",
        originalName="message.eml",
        mimeType="message/rfc822",
        payload={
            "messageId": "abc",
            "from": "sender@example.com",
            "to": ["ops@northwind.com"],
            "subject": "Invoice INV-2026-0042",
            "date": "2026-02-14T10:00:00Z",
            "bodyText": "Please find invoice INV-2026-0042 for 610.00 EUR attached.",
            "attachments": [{"filename": "invoice.pdf"}],
        },
    )
    output = ENGINES["email"].run(request)
    assert output.compilation.rows[0].data["Sender"] == "sender@example.com"
    assert output.compilation.rows[0].data["Attachments"] == 1
    assert output.demo is False


def test_voice_activity_detection_finds_speech_burst() -> None:
    import numpy as np

    rate = 16_000
    signal = np.zeros(rate * 3, dtype=np.float32)
    t = np.arange(rate) / rate
    signal[rate : rate * 2] = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    segments = voice_activity(signal, rate)
    assert len(segments) == 1
    start, end = segments[0]
    assert 0.9 <= start <= 1.1 and 1.9 <= end <= 2.2


def test_capabilities_reports_engine_availability_honestly() -> None:
    response = client.get("/v1/capabilities", headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert set(body["engines"]) == {"document", "invoice", "email", "audio", "image", "cctv", "drone"}
    assert "distance" in body["measurements"]


def test_unauthenticated_requests_are_rejected() -> None:
    assert client.get("/v1/capabilities").status_code == 401
    assert client.post("/v1/measure", json={"operation": "distance", "params": {}}).status_code == 401


def test_measure_endpoint_computes_distance() -> None:
    response = client.post(
        "/v1/measure",
        headers=AUTH,
        json={"operation": "distance", "params": {"from": [24.7536, 59.4370], "to": [24.9384, 60.1699]}},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "MEASURED"


def test_cctv_without_detector_is_unavailable_not_faked() -> None:
    available, detail = ENGINES["cctv"].availability()
    if available:
        pytest.skip("detector installed in this environment")
    response = client.post(
        "/v1/process/cctv",
        headers=AUTH,
        json={
            "fileReference": "DSX-2026-000002",
            "originalName": "cctv.mp4",
            "mimeType": "video/mp4",
            "fileUrl": "http://localhost/none",
            "mode": "real",
        },
    )
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"].lower()


def test_demo_mode_is_explicitly_marked() -> None:
    response = client.post(
        "/v1/process/invoice",
        headers=AUTH,
        json={
            "fileReference": "DSX-2026-000003",
            "originalName": "invoice.pdf",
            "mimeType": "application/pdf",
            "mode": "demo",
        },
    )
    body = response.json()
    assert body["demo"] is True
    assert any("DEMO MODE" in w for w in body["warnings"])


def test_unknown_engine_returns_404() -> None:
    response = client.post(
        "/v1/process/telepathy",
        headers=AUTH,
        json={"fileReference": "x", "originalName": "y", "mimeType": "text/plain"},
    )
    assert response.status_code == 404


def _write_jpeg_with_exif(path: Path, exif: dict[int, object]) -> Path:
    Image.new("RGB", (64, 48), "gray").save(path, "JPEG")
    piexif.insert(piexif.dump({"Exif": exif}), str(path))
    return path


def test_drone_derives_sensor_width_from_exif_focal_plane_resolution(tmp_path: Path) -> None:
    """A 4000 px wide frame at 400 px/mm is a 10 mm sensor — derived, not assumed."""
    path = _write_jpeg_with_exif(
        tmp_path / "frame.jpg",
        {
            piexif.ExifIFD.PixelXDimension: 4000,
            piexif.ExifIFD.FocalPlaneXResolution: (10160, 1),  # px per inch
            piexif.ExifIFD.FocalPlaneResolutionUnit: 2,
        },
    )
    assert read_metadata(path)["sensorWidthMm"] == pytest.approx(10.0, abs=0.01)


def test_drone_omits_sensor_width_when_exif_lacks_focal_plane_resolution(tmp_path: Path) -> None:
    path = _write_jpeg_with_exif(tmp_path / "plain.jpg", {piexif.ExifIFD.PixelXDimension: 4000})
    assert "sensorWidthMm" not in read_metadata(path)


def _straight_track() -> Track:
    return Track(
        track_id=1,
        label="car",
        detections=[
            Detection(label="car", confidence=0.9, box=(x, 590.0, x + 20, 610.0), frame=i, timestamp=i * 0.5)
            for i, x in enumerate((40.0, 200.0, 400.0, 600.0))
        ],
    )


CALIBRATION = load_calibration(
    {
        "points": [
            {"x": 40, "y": 600, "worldX": 0, "worldY": 0},
            {"x": 600, "y": 600, "worldX": 12, "worldY": 0},
            {"x": 560, "y": 300, "worldX": 12, "worldY": 20},
            {"x": 90, "y": 300, "worldX": 0, "worldY": 20},
        ]
    }
)


def test_cctv_emits_no_geojson_geometry_without_a_georeference() -> None:
    """Pixel or local-metre tracks must never be exported as WGS84 coordinates."""
    assert CCTVEngine._track_geometry(_straight_track(), CALIBRATION, None) is None
    assert CCTVEngine._track_geometry(_straight_track(), load_calibration(None), (59.437, 24.7536, 0.0)) is None


def test_cctv_georeferenced_track_produces_wgs84_linestring() -> None:
    geometry = CCTVEngine._track_geometry(_straight_track(), CALIBRATION, (59.437, 24.7536, 0.0))
    assert geometry is not None
    assert geometry["type"] == "LineString"
    coordinates = geometry["coordinates"]
    assert len(coordinates) == 4
    assert all(-180 <= lon <= 180 and -90 <= lat <= 90 for lon, lat in coordinates)
    # The track spans the calibrated 12 m baseline, so the ends are ~12 m apart.
    assert geo.geodesic_distance(coordinates[0], coordinates[-1]) == pytest.approx(12, abs=1.5)
