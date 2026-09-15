# DataSynx database

The complete schema lives in `database/schema.prisma`; every change to it is
captured as a SQL migration in `database/migrations/`. Nothing is created at
runtime — the tables, foreign keys, indexes and constraints below all come from
those migration files, so any PostgreSQL server (your local Windows install
included) can be brought to the exact same state by running the migrations.

## Run the migrations against your own PostgreSQL

1. Install dependencies once: `npm install`
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your server, e.g.

   ```
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/datasynx?schema=public
   ```

   The database (`datasynx`) must exist first; create it with
   `createdb -U postgres datasynx` or in pgAdmin.

3. Apply every migration and regenerate the Prisma client:

   ```
   npm run db:setup
   ```

   That is the one command to create or update all DataSynx tables. It runs
   `prisma migrate deploy` (applies pending migrations, never drops data) and
   then `prisma generate`.

Related commands:

| Command | What it does |
| --- | --- |
| `npm run db:setup` | Apply all migrations + generate the client (use this) |
| `npm run db:deploy` | Apply pending migrations only |
| `npm run db:status` | Show which migrations are applied/pending |
| `npm run db:migrate` | Create a new migration after editing the schema (dev only) |
| `npm run db:seed` | Create the first owner account, workspace and reference counters |
| `npm run db:studio` | Browse the data in Prisma Studio |

Seeding reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (min. 12 characters)
from `.env`; it is idempotent and never deletes anything. Registering through
the UI works just as well — seeding only saves the first sign-up.

On Windows, run the commands from the repository root in PowerShell or Command
Prompt with Node 20+ installed. Redis and S3-compatible object storage are only
needed to *run* the app, not to migrate the database.

## Model map

Identity and tenancy
- `User` — accounts (password or Google), unique `email`, unique `googleId`.
- `Session` — refresh-token sessions, hashed tokens, expiry.
- `PasswordReset` — single-use reset tokens.
- `Workspace` / `WorkspaceMember` — tenancy boundary; every business row is
  scoped by `workspaceId`, and membership carries the role (OWNER/ADMIN/MEMBER/VIEWER).

Import
- `Import` — an upload batch (manual, email, archive).
- `FileObject` — one stored original: reference (`DSX-YYYY-NNNNNN`), hash,
  modality, scan status, object-storage key, optional `archiveId` for members
  extracted from an archive (archive lineage).

Processing
- `ProcessingJob` / `ProcessingItem` — batch and per-file state machine with
  attempts and error text, so one failure never fails the batch.
- `ProcessingResult` — structured output per item, with engine, engine version,
  confidence and origin (AI/DETERMINISTIC/HUMAN).
- `EventClip` — derived CCTV clips (pre/event/post window) with full lineage to
  file, result, subject, event kinds and storage key; originals are never
  modified.
- `CameraCalibration` — optional calibration; without it distances and speeds
  stay `UNAVAILABLE` rather than being invented.

Compilation and export
- `Compilation` / `CompilationRecord` — one table per workspace+modality and its
  rows, with soft removal so rows can be restored.
- `ExportJob` — export requests (XLSX/CSV/PDF/JSON/GEOJSON/TXT/DOCX) with row
  count, size and storage key.

Control and audit
- `ProcessingCommand` — every natural-language command, the whitelisted
  operation it mapped to, and its status.
- `AuditLog` — actor, action, entity and metadata for security-relevant events.
- `ReferenceCounter` — atomic per-year counters behind the human-readable
  references.

Training
- `Correction` — human corrections against a result or compiled row, typed
  values preserved.
- `TrainingDataset` / `DatasetVersion` / `DatasetItem` — curated datasets.
- `ModelVersion` / `EvaluationRun` — registered models per modality (one active
  per workspace+modality, enforced by a partial unique index) and their
  evaluations.

## Constraints worth knowing

- Every child row cascades from its `Workspace`, so deleting a workspace cleans
  up its data.
- `Compilation` is unique on `(workspaceId, modality)`; `CompilationRecord` is
  unique on `(compilationId, rowKey)`.
- `EventClip` is unique on `(resultId, clipKey)` and indexed by
  `(workspaceId, createdAt)` and `(fileId, startTime)` for chronological lookup.
- `FileObject` carries a `(workspaceId, checksumSha256)` index for duplicate
  detection, plus an `archiveId` index for archive members.
- Only one `ModelVersion` per `(workspaceId, modality)` can be active.
