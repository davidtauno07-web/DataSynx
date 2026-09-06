---
name: testing-datasynx-e2e
description: How to run and UI-test the DataSynx monorepo end-to-end locally (infra, services, fixtures, auth, import/processing/export golden path, known gotchas).
---

# DataSynx local E2E testing

## Bring the stack up (repo root)

1. `docker compose up -d` — Postgres 5432, Redis 6379, MinIO 9000/9001.
2. `npm run db:deploy` if the Prisma schema is not applied.
3. AI service: `cd apps/ai && .venv/bin/uvicorn app.main:app --port 8000`
   (the venv already carries the CV/ASR deps: ultralytics/YOLO, opencv, exif).
4. API: `npm run dev --workspace apps/api` (port 4000) **and** the separate BullMQ
   worker entry `src/worker` — processing/export jobs never finish without the worker.
5. Web: `npm run dev --workspace apps/web` → http://localhost:5173 (Vite proxies `/api` to
   :4000 same-origin, so cookie auth works in the browser; do NOT test authed flows with curl).

Sanity check: `curl localhost:4000/health` → `{"status":"ok","mode":"real"}`.

## Auth

Register a fresh account from `/register` (any unique email + password). Protected routes
(`/import`, `/processing`, `/export`) are wrapped in `RequireAuth` (apps/web/src/App.tsx) and
redirect to `/login` when signed out.

## Fixtures

`/home/ubuntu/e2e` holds `make_invoices.mjs` (invoice-00N.pdf) and `make_media.py`
(cctv-forecourt.mp4, drone-site.jpg with GPS EXIF, site-note.wav). Regenerate if missing.

## Golden path tips

- Upload multiple files in **one** GTK file dialog (shift-select). Repeatedly reopening the
  chooser in the VM is flaky; if a file fails to attach, reload `/import` and retry once.
- The Processing page renders only the job's *current* item (`GET /processing/jobs/:id/current`
  = first in-flight item, else the most recently finished). To inspect a specific item's result
  (e.g. the drone image in a mixed batch), **re-upload that file and process it as its own
  single-item job** — there is no per-item picker in the UI.
- Command input placeholder: `Ask DataSynx to process, calculate, filter, or reprocess...`.
  `Show only supplier and total` maps to a `show_columns` operation
  (apps/api/src/modules/commands/parser.ts). Note the Export compilation table is not
  column-restricted by this command — verify the command response payload, not the export table.
- Exports run in the worker; rows appear in the Exports table with Rows/Size and a Download
  button. Downloads land in `~/Downloads`. `file` is not installed — validate with Python
  (`zipfile` for XLSX, `openpyxl` via `apps/ai/.venv/bin/python`, `json.load` for GeoJSON).
- GeoJSON on a non-spatial (invoice) compilation must FAIL with
  "This compilation contains no spatial geometry, so GeoJSON cannot be produced".

## Measurement semantics (the core safety property)

- Uncalibrated CCTV must report Distance/Speed as `UNAVAILABLE` (never a number); Direction is
  `MEASURED` in degrees. See apps/ai/app/engines/cctv.py.
- Drone: GPS lat/lon/altitude come from EXIF, but sizes (width/length/area/perimeter) are
  `UNAVAILABLE` unless ground sample distance can be computed (needs altitude **and sensor
  width** and focal length and image width). The stock fixture lacks sensor width, so every
  drone measurement row is UNAVAILABLE — that is correct behaviour, not a bug. If you need a
  MEASURED drone size row, add a sensor-width EXIF/telemetry field to the fixture.

## Known issues seen at time of writing (may still be present)

- Duplicate pill renders "Possible duplicate of" with **no reference**: the API returns
  `duplicateOf` as a string (apps/api/src/modules/ingestion/service.ts) while
  apps/web/src/pages/import/ManualUpload.tsx reads `duplicateOf.reference`.
- Concurrent items in one batch can fail with Prisma P2002 on `(workspaceId, modality)` in
  `prisma.compilation.upsert()` (apps/api/src/modules/compilation/service.ts). "Retry failed"
  in the UI recovers it. Watch the worker log when a batch reports failed items.
- Export page compilation dropdown shows "· <blank> rows" (missing rowCount).
- The VM has no microphone: the voice recorder errors with "Requested device not found".
  Report as an environment limitation; do not fake a recording.

## Devin Secrets Needed

None — everything runs locally from the root `.env`.
