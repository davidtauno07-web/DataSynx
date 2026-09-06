# DataSynx

Multimodal data processing, structuring, compilation and export platform.

> **AI perceives. Software calculates. DataSynx structures and compiles.**

DataSynx ingests data that is too large, too complex or too time-consuming to process
manually, routes each file to a **specialised pipeline for its modality**, applies
deterministic mathematics for any physical measurement, persists every result into a
compilation, and exports that compilation to XLSX / CSV / PDF / JSON / GeoJSON / TXT / DOCX.

The product surface is deliberately three pages:

```
IMPORT  →  PROCESSING  →  EXPORT
```

Everything else (OCR, computer vision, transcription, geospatial math, cleaning,
compilation, queues) is backend infrastructure, never an extra page.

---

## Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Object storage](#object-storage)
- [AI models and providers](#ai-models-and-providers)
- [Worker architecture](#worker-architecture)
- [Processing pipelines](#processing-pipelines)
- [Measurement engine](#measurement-engine)
- [Compilation and export](#compilation-and-export)
- [Security](#security)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
                         DATASYNX
                            |
                      AUTHENTICATION
                            |
                          IMPORT
              ┌─────────────┼─────────────┐
            VOICE         EMAIL         UPLOAD
              └─────────────┼─────────────┘
                            ↓
                    INGESTION ENGINE          (validate, hash, scan, DSX ref, store original)
                            ↓
                     DATA TYPE ROUTER         (deterministic, signature based)
                            ↓
      ┌───────────┬─────────┼──────────┬───────────┬──────────┐
   DOCUMENT    INVOICE    EMAIL      AUDIO       CCTV       DRONE
    engine      engine    engine     engine      engine     engine
      └───────────┴─────────┼──────────┴───────────┴──────────┘
                            ↓
                    MEASUREMENT ENGINE        (deterministic math / geodesy, never an LLM)
                            ↓
                    COMPILATION ENGINE        (persistent dataset)
                            ↓
              XLSX · CSV · PDF · JSON · GEOJSON · TXT · DOCX
```

Three runtimes:

| Runtime | Role |
| --- | --- |
| `apps/api` (Node 20 + TypeScript + Express + Prisma) | HTTP API, auth, ingestion, queues, compilation, exports |
| `apps/api` worker (BullMQ) | Asynchronous processing and export jobs |
| `apps/ai` (Python 3.10 + FastAPI) | Perception engines (OCR, ASR, detection/tracking) and deterministic measurement engines |
| `apps/web` (React 18 + Vite + TypeScript) | Import / Processing / Export UI |

Modalities never mix automatically. A CCTV video is only ever handled by the CCTV
pipeline; shared infrastructure (ingestion, storage, queueing, compilation, export) is
the only thing they have in common.

## Repository layout

```
apps/api        Express API, Prisma schema, BullMQ workers, export generators
apps/ai         FastAPI AI service: engines/ (perception) and measure/ (mathematics)
apps/web        React frontend (three pages + auth)
docker-compose.yml   PostgreSQL 16, Redis 7, MinIO
```

## Setup

Prerequisites: Node.js 20+, Python 3.10+, Docker (for Postgres/Redis/MinIO), FFmpeg.

```bash
git clone https://github.com/davidtauno07-web/DataSynx.git
cd DataSynx
cp .env.example .env            # then edit secrets

docker compose up -d            # postgres, redis, minio

npm install
npm run db:migrate              # prisma migrate dev
npm run dev                     # api + worker + web (concurrently)
```

Python AI service (separate terminal):

```bash
cd apps/ai
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# optional, heavy: OpenCV, Ultralytics, faster-whisper, pytesseract
.venv/bin/pip install -r requirements-optional.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- Frontend: http://localhost:5173
- API: http://localhost:4000 (`/health`)
- AI service: http://localhost:8000 (`/health`)
- MinIO console: http://localhost:9001

## Environment variables

All configuration lives in `.env` (see `.env.example`; never commit real secrets).

| Group | Keys | Notes |
| --- | --- | --- |
| API | `API_PORT`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `LOG_LEVEL` | |
| Database | `DATABASE_URL` | PostgreSQL 16 |
| Queue | `REDIS_URL` | BullMQ + pub/sub for SSE |
| Storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | MinIO, AWS S3 or R2 |
| Auth | `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `COOKIE_SECRET`, `COOKIE_SECURE` | 32-byte hex secrets |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | Sign-in disappears from the UI when unset |
| Gmail connector | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_OAUTH_REDIRECT_URI` | read-only scope only |
| Token encryption | `TOKEN_ENCRYPTION_KEY` | AES-256-GCM for stored OAuth tokens |
| AI service | `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `AI_REQUEST_TIMEOUT_MS` | |
| Mode | `DATASYNX_MODE=real\|demo` | see below |
| LLM provider | `LLM_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`, `LLM_MODEL` | optional refinement only |
| Models | `MODEL_CACHE_DIR`, `DETECTION_MODEL`, `DETECTION_DEVICE`, `ASR_MODEL`, `ASR_DEVICE`, `OCR_ENGINE` | |
| Uploads | `MAX_UPLOAD_BYTES`, `CLAMAV_HOST`, `CLAMAV_PORT` | ClamAV optional |

### real vs demo mode

`DATASYNX_MODE=real` is the default. When a model, weight file or runtime is missing,
the engine returns an explicit failure or an `UNAVAILABLE` measurement — it never
fabricates output. `DATASYNX_MODE=demo` produces synthetic results for UI development;
every such result carries `demo: true` and is labelled **“Demo result — not real
processing”** in the UI. The two modes are never mixed.

## Database

PostgreSQL via Prisma (`apps/api/prisma/schema.prisma`). Core entities: `User`,
`Session`, `PasswordReset`, `AuthProvider`, `Workspace`, `WorkspaceMember`, `Import`,
`File`, `ProcessingJob`, `ProcessingItem`, `ProcessingResult`, `Compilation`,
`CompilationRecord`, `ProcessingCommand`, `AuditLog`, `ExportJob`, `GmailAccount`,
`CameraCalibration`, `ReferenceCounter`.

```bash
npm run db:migrate            # dev migration
npm run db:deploy             # production
npm run db:generate           # regenerate the Prisma client
```

Human references are allocated atomically from `ReferenceCounter`:
`DSX-2026-000001` (file), `IMP-…` (import), `JOB-…` (job), `EXP-…` (export).

Large media never lives in a row — only metadata and a storage key.

## Object storage

S3-compatible (MinIO locally). Storage keys are generated server-side from opaque IDs,
never from user-supplied filenames, which eliminates path traversal through uploads.
The **original upload is immutable**: preprocessing and derivatives are written to new
keys, and the UI reads originals through short-lived presigned URLs.

## AI models and providers

The Python service exposes `POST /v1/process/{engine}` and `POST /v1/measure` behind a
bearer token. Engines are interchangeable implementations:

| Concern | Default | Replaceable via |
| --- | --- | --- |
| Object detection / tracking | Ultralytics YOLO + ByteTrack | `Detector` protocol (`app/engines/vision.py`) |
| Speech recognition | faster-whisper | `ASR_MODEL` / engine module |
| OCR | pytesseract | `OCR_ENGINE` |
| LLM refinement (optional) | none | `LLM_PROVIDER` (openai / anthropic / ollama) |

Model weights are downloaded into `MODEL_CACHE_DIR` and are **not** committed. GPU is
used automatically when CUDA/MPS is available (`DETECTION_DEVICE=auto`); CPU otherwise.
An LLM is never asked to produce a physical measurement.

## Worker architecture

```
POST /api/processing/jobs → job + items persisted → BullMQ enqueue
   worker → download original → route to engine → structure result
          → persist ProcessingResult → append CompilationRecord
          → publish Redis event → SSE → UI
```

- Item states: `IMPORTED → QUEUED → PREPROCESSING → PROCESSING → STRUCTURING → COMPILED → COMPLETED`, plus `FAILED` and `CANCELLED`.
- A failed item never stops the batch; successful results are kept and failed items can be retried independently (`POST /api/processing/jobs/:id/retry`).
- Live updates: `GET /api/processing/stream` (SSE, workspace-scoped) backed by Redis pub/sub, with a polling backstop in the UI.

## Processing pipelines

| Modality | Pipeline |
| --- | --- |
| Document | PDF text layer → OCR fallback → DOCX/TXT/CSV/XLSX parsing → classification → structured fields |
| Invoice | document extraction → field extraction (number, supplier, dates, currency, line items, subtotal, VAT, total, PO, IBAN) → arithmetic reconciliation warnings (printed values are never overwritten) |
| Email | header/body/entity structuring for user-selected messages only |
| Audio | FFmpeg normalisation → high-pass → denoise → loudnorm → VAD → transcription with timestamps; speakers are labelled as unidentified unless there is real identification evidence |
| CCTV | validation → frame extraction → detection → tracking → trajectories → counts, entry/exit, direction, dwell, zones, line crossings → calibrated distance/speed **only** where camera calibration exists |
| Drone | EXIF/telemetry extraction → detection → GSD computation → geospatial measurements → GeoJSON |

Missing metadata is reported as missing. Nothing is invented.

## Measurement engine

Deterministic only (`apps/ai/app/measure/`):

- `geo.py` — WGS84 geodesic distance, bearing/compass, polygon area and perimeter, path length, CRS transformation, ground sample distance (`pyproj`, `shapely`).
- `kinematics.py` — camera calibration (uniform scale or 4+ point homography solved with NumPy SVD), pixel→world transformation, track distance, speed, direction.

Every measurement carries a status: `MEASURED`, `ESTIMATED` or `UNAVAILABLE` (with a
reason such as “Camera calibration missing”), plus method, unit and source.

## Compilation and export

Each completed result is appended to a per-modality `Compilation` as a
`CompilationRecord` (with optional GeoJSON geometry). Exports read **only** the
persisted compilation — the AI pipeline is never re-run for an export — and run in the
export queue, storing the artefact in object storage and handing back a presigned link.

| Format | Notes |
| --- | --- |
| XLSX | typed cells (numbers/dates), frozen bold header, separate Metadata sheet |
| CSV | RFC 4180, BOM, CRLF, quoted strings |
| PDF | landscape report with title, dataset metadata, paginated table |
| JSON | records + columns + compilation metadata |
| GeoJSON | FeatureCollection; refuses to generate when the compilation has no geometry |
| TXT | readable per-record report |
| DOCX | editable report with a real Word table |

## Security

Argon2id password hashing; JWT access tokens plus rotating refresh sessions stored only
as SHA-256 hashes; httpOnly/SameSite cookies; Zod validation on every route; rate
limiting on auth and upload routes; Helmet security headers; audit logging of imports,
commands, exports and auth events; AES-256-GCM encryption of stored OAuth tokens;
magic-byte + extension + size + structure validation on every upload; optional ClamAV
(reports `SKIPPED`, never a false “clean”); redacted structured logs (pino). The
command assistant only ever executes whitelisted structured operations — free text is
never executed, originals are never modified or deleted, and every operation is scoped
to the caller's workspace.

## Testing

```bash
npm run lint && npm run typecheck && npm run test    # API + web
npm run build

cd apps/ai
.venv/bin/python -m pytest        # engines + measurement math
.venv/bin/ruff check app tests
```

Coverage includes: deterministic geodesy (distance/bearing/area/perimeter/CRS/GSD),
CCTV kinematics with and without calibration, invoice extraction and reconciliation,
document/CSV extraction, email structuring, VAD, AI-service auth and unavailable
behaviour, demo-mode tagging, content routing, upload validation (spoofed signature,
traversal, unsupported type, empty file), command parsing safety, all seven export
generators, and the frontend result view / auth flows.

## Deployment

1. Provision PostgreSQL, Redis and an S3-compatible bucket.
2. `npm run build`, then run `npm run start --workspace apps/api` and `npm run start:worker --workspace apps/api` as separate processes (scale workers horizontally).
3. Serve `apps/web/dist` from any static host/CDN, proxying `/api` to the API.
4. Run the AI service (`uvicorn app.main:app`) on CPU or GPU hosts; scale it independently of the API.
5. Set `COOKIE_SECURE=true` and terminate TLS in front of the API.
6. Run `npm run db:deploy` on release.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `AI processing unavailable` | AI service down or `AI_SERVICE_TOKEN` mismatch — check `GET /health` on port 8000 |
| Engine returns 503 in real mode | optional dependency or model weight missing; install `requirements-optional.txt` or switch to `DATASYNX_MODE=demo` for UI work |
| Speed/distance `UNAVAILABLE` | no camera calibration for that source — this is honest behaviour, add a `CameraCalibration` |
| Drone measurements `UNAVAILABLE` | image has no GPS/EXIF camera metadata, so no valid GSD |
| Uploads rejected | signature/extension mismatch or unsupported type; the API states which |
| No live updates | SSE blocked by a proxy; the UI falls back to polling every 3s |
| Prisma `P1001` | `docker compose up -d` not run, or `DATABASE_URL` wrong |
| Export stuck in `QUEUED` | worker process not running (`npm run dev:worker`) |
