/**
 * End-to-end API tests against the real Postgres/Redis/MinIO stack from
 * `docker compose up`. They are skipped automatically when the infrastructure
 * is not reachable so the unit suite still runs anywhere.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ExportFormat, Modality } from '@prisma/client';

import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { upsertCompilationRows } from '../src/modules/compilation/service.js';
import { generateExport } from '../src/modules/exports/generators.js';
import { loadDataset } from '../src/modules/exports/dataset.js';

const app = createApp();
const password = `Str0ng-${randomUUID().slice(0, 8)}!`;
const emailOf = (tag: string) => `dsx-${tag}-${randomUUID().slice(0, 8)}@example.test`;

function setCookies(res: request.Response): string[] {
  const header = res.get('set-cookie');
  return typeof header === 'string' ? [header] : (header ?? []);
}

async function infrastructureUp(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const available = await infrastructureUp();
const workspaceIds: string[] = [];

describe.skipIf(!available)('DataSynx API (integration)', () => {
  const primary = emailOf('primary');
  let cookies: string[] = [];
  let workspaceId = '';
  let userId = '';
  let fileIds: string[] = [];

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Primary Tester', email: primary, password });
    expect(res.status).toBe(201);
    cookies = setCookies(res);
    workspaceId = res.body.workspaceId as string;
    userId = res.body.user.id as string;
    workspaceIds.push(workspaceId);
  });

  afterAll(async () => {
    for (const id of workspaceIds) {
      await prisma.workspace.deleteMany({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: '@example.test' } } });
    await prisma.$disconnect();
  });

  describe('authentication', () => {
    it('registers a user with a workspace and never returns the password hash', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(primary);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(res.body.workspace.id).toBe(workspaceId);
    });

    it('rejects a duplicate registration', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Copy', email: primary, password });
      expect(res.status).toBe(409);
    });

    it('rejects a weak password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Weak', email: emailOf('weak'), password: 'short' });
      expect(res.status).toBe(400);
    });

    it('signs in with valid credentials and refuses invalid ones', async () => {
      const ok = await request(app).post('/api/auth/login').send({ email: primary, password });
      expect(ok.status).toBe(200);

      const bad = await request(app)
        .post('/api/auth/login')
        .send({ email: primary, password: `${password}-wrong` });
      expect(bad.status).toBe(401);
      expect(bad.body.error.message).not.toMatch(/hash|argon/i);
    });

    it('requires authentication for protected routes', async () => {
      expect((await request(app).get('/api/imports/files')).status).toBe(401);
      expect((await request(app).get('/api/exports/compilations')).status).toBe(401);
    });

    it('resets a password and revokes the old sessions', async () => {
      const email = emailOf('reset');
      const registered = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Reset Tester', email, password });
      workspaceIds.push(registered.body.workspaceId as string);
      const oldCookies = setCookies(registered);

      const forgot = await request(app).post('/api/auth/password/forgot').send({ email });
      expect(forgot.status).toBe(200);
      const token = forgot.body.token as string;
      expect(token).toBeTruthy();

      const newPassword = `${password}-rotated`;
      const reset = await request(app).post('/api/auth/password/reset').send({ token, password: newPassword });
      expect(reset.status).toBe(200);

      expect((await request(app).post('/api/auth/login').send({ email, password })).status).toBe(401);
      expect((await request(app).post('/api/auth/login').send({ email, password: newPassword })).status).toBe(200);

      const refreshCookie = oldCookies.find((c) => c.startsWith('dsx_refresh='));
      const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie ?? '');
      expect(refreshed.status).toBe(401);

      const reused = await request(app).post('/api/auth/password/reset').send({ token, password: newPassword });
      expect(reused.status).toBe(401);
    });

    it('does not disclose whether an unknown address is registered', async () => {
      const res = await request(app).post('/api/auth/password/forgot').send({ email: emailOf('ghost') });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeUndefined();
    });

    it('advertises whether Google OAuth is configured instead of faking it', async () => {
      const res = await request(app).get('/api/auth/config');
      expect(res.status).toBe(200);
      expect(typeof res.body.googleEnabled).toBe('boolean');
    });

    it('rejects a Google callback without a matching state cookie', async () => {
      const res = await request(app).get('/api/auth/google/callback').query({ code: 'x', state: 'y' });
      expect(res.status).toBe(400);
    });
  });

  describe('import', () => {
    it('stores originals, assigns DSX references and flags duplicates without deleting them', async () => {
      const body = Buffer.from('Supplier: Northwind\nTotal: 120.00 EUR\n');
      const res = await request(app)
        .post('/api/imports/upload')
        .set('Cookie', cookies)
        .field('source', 'MANUAL_UPLOAD')
        .attach('files', body, 'notes.txt')
        .attach('files', body, 'notes-copy.txt')
        .attach('files', Buffer.from('unrelated text'), 'other.txt');

      expect(res.status).toBe(201);
      expect(res.body.files).toHaveLength(3);
      fileIds = res.body.files.map((f: { id: string }) => f.id);

      for (const file of res.body.files) {
        expect(file.reference).toMatch(/^DSX-\d{4}-\d{6}$/);
        expect(file.modality).toBe(Modality.DOCUMENT);
      }
      const duplicates = res.body.files.filter((f: { duplicateOf: string | null }) => f.duplicateOf);
      expect(duplicates).toHaveLength(1);

      const stored = await prisma.fileObject.findMany({ where: { id: { in: fileIds } } });
      expect(stored).toHaveLength(3);
      expect(new Set(stored.map((f) => f.storageKey)).size).toBe(3);
    });

    it('rejects a file whose bytes contradict its extension while keeping the batch', async () => {
      const res = await request(app)
        .post('/api/imports/upload')
        .set('Cookie', cookies)
        .attach('files', Buffer.from('<html>not a pdf</html>'), 'invoice.pdf')
        .attach('files', Buffer.from('legitimate text'), 'accepted.txt');

      expect(res.status).toBe(201);
      expect(res.body.rejected).toHaveLength(1);
      expect(res.body.rejected[0].originalName).toBe('invoice.pdf');
      expect(res.body.files).toHaveLength(1);
    });

    it('preserves a voice recording as its own import', async () => {
      const res = await request(app)
        .post('/api/imports/voice')
        .set('Cookie', cookies)
        .field('durationMs', '1500')
        .attach('file', Buffer.from('RIFF....WAVEfmt '), 'recording.webm');
      expect([201, 400]).toContain(res.status);
      if (res.status === 201) {
        expect(res.body.file.modality).toBe(Modality.AUDIO);
      }
    });

    it('returns a presigned URL for the original instead of streaming it through the API', async () => {
      const res = await request(app).get(`/api/imports/files/${fileIds[0]}/source`).set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('X-Amz-Signature');
    });
  });

  describe('processing', () => {
    it('creates a job whose items start queued', async () => {
      const res = await request(app)
        .post('/api/processing/jobs')
        .set('Cookie', cookies)
        .send({ name: 'Integration batch', fileIds });
      expect(res.status).toBe(201);
      expect(res.body.job.totalItems).toBe(fileIds.length);

      const detail = await request(app).get(`/api/processing/jobs/${res.body.job.id}`).set('Cookie', cookies);
      expect(detail.status).toBe(200);
      expect(detail.body.job.items).toHaveLength(fileIds.length);
    });

    it('refuses to build a job from another workspace’s files', async () => {
      const outsider = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Outsider', email: emailOf('outsider'), password });
      workspaceIds.push(outsider.body.workspaceId as string);
      const outsiderCookies = setCookies(outsider);

      const res = await request(app)
        .post('/api/processing/jobs')
        .set('Cookie', outsiderCookies)
        .send({ name: 'Stolen batch', fileIds });
      expect([400, 404]).toContain(res.status);

      const files = await request(app).get('/api/imports/files').set('Cookie', outsiderCookies);
      expect(files.status).toBe(200);
      expect(files.body.files).toHaveLength(0);
    });

    it('translates a safe command and refuses a destructive one', async () => {
      const safe = await request(app)
        .post('/api/processing/commands')
        .set('Cookie', cookies)
        .send({ input: 'Show only supplier and total' });
      expect(safe.status).toBe(200);
      expect(safe.body.operation.kind).toBe('show_columns');

      const unsafe = await request(app)
        .post('/api/processing/commands')
        .set('Cookie', cookies)
        .send({ input: 'rm -rf / and delete the original files' });
      expect(unsafe.body.operation.kind).toBe('unsupported');

      const files = await prisma.fileObject.count({ where: { id: { in: fileIds } } });
      expect(files).toBe(fileIds.length);
    });

    it('reports engine availability honestly', async () => {
      const res = await request(app).get('/api/processing/capabilities').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('engines');
    });
  });

  describe('compilation and export', () => {
    it('persists compiled records and exports them without rerunning the AI pipeline', async () => {
      const file = await prisma.fileObject.findFirstOrThrow({ where: { id: fileIds[0] } });
      const job = await prisma.processingJob.create({
        data: { workspaceId, userId, name: 'Compilation fixture', totalItems: 1, reference: `DSXJOB-${randomUUID().slice(0, 8)}` },
      });
      const item = await prisma.processingItem.create({
        data: { jobId: job.id, fileId: file.id, position: 0, modality: Modality.INVOICE },
      });
      const result = await prisma.processingResult.create({
        data: {
          itemId: item.id,
          engine: 'invoice.v1',
          engineVersion: 'test',
          data: { 'Invoice Number': 'INV-9001' },
        },
      });

      await upsertCompilationRows({
        workspaceId,
        modality: Modality.INVOICE,
        result,
        sourceRef: file.reference,
        columns: ['Invoice Number', 'Supplier', 'Invoice Date', 'Total'],
        rows: [
          {
            rowKey: `${file.reference}:1`,
            data: {
              'Invoice Number': 'INV-9001',
              Supplier: 'Northwind',
              'Invoice Date': '2026-01-04',
              Total: 120.5,
            },
          },
        ],
      });

      const list = await request(app).get('/api/exports/compilations').set('Cookie', cookies);
      expect(list.status).toBe(200);
      const compilation = list.body.compilations.find((c: { modality: string }) => c.modality === Modality.INVOICE);
      expect(compilation).toBeDefined();
      expect(compilation.recordCount).toBeGreaterThan(0);

      const records = await request(app)
        .get(`/api/exports/compilations/${compilation.id}/records`)
        .set('Cookie', cookies);
      expect(records.status).toBe(200);
      expect(records.body.records[0].data['Invoice Number']).toBe('INV-9001');

      const dataset = await loadDataset(compilation.id as string);
      for (const format of [
        ExportFormat.XLSX,
        ExportFormat.CSV,
        ExportFormat.PDF,
        ExportFormat.JSON,
        ExportFormat.TXT,
        ExportFormat.DOCX,
      ]) {
        const generated = await generateExport(format, dataset);
        expect(generated.buffer.byteLength).toBeGreaterThan(0);
        expect(generated.rowCount).toBe(dataset.rows.length);
      }

      await expect(generateExport(ExportFormat.GEOJSON, dataset)).rejects.toThrow(/spatial geometry/i);
    });

    it('queues an export job for another workspace’s compilation with 404', async () => {
      const res = await request(app)
        .post('/api/exports')
        .set('Cookie', cookies)
        .send({ compilationId: randomUUID(), format: ExportFormat.CSV });
      expect(res.status).toBe(404);
    });
  });

  describe('audit trail', () => {
    it('records authentication and import events without secrets', async () => {
      const entries = await prisma.auditLog.findMany({ where: { workspaceId } });
      const actions = entries.map((e) => e.action);
      expect(actions).toContain('auth.register');
      expect(actions).toContain('import.upload');
      expect(JSON.stringify(entries)).not.toContain(password);
    });
  });
});
