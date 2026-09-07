import { ExportFormat, ExportStatus, type ExportJob } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { nextExportReference } from '../../lib/references.js';
import { buildStorageKey, presignGet, putObject } from '../../lib/storage.js';
import { getExportQueue } from '../../queue/queues.js';
import { publishEvent } from '../../events/bus.js';
import { loadDataset } from './dataset.js';
import { generateExport } from './generators.js';
import { toJson } from '../../lib/json.js';

export async function queueExport(input: {
  workspaceId: string;
  userId: string;
  compilationId: string;
  format: ExportFormat;
  options?: Record<string, unknown>;
}): Promise<ExportJob> {
  const compilation = await prisma.compilation.findFirst({
    where: { id: input.compilationId, workspaceId: input.workspaceId },
  });
  if (!compilation) throw notFound('Compilation not found');

  const job = await prisma.exportJob.create({
    data: {
      reference: await nextExportReference(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      compilationId: compilation.id,
      format: input.format,
      options: toJson(input.options),
    },
  });

  await getExportQueue().add('generate-export', {
    exportJobId: job.id,
    workspaceId: input.workspaceId,
  });

  await publishEvent({
    type: 'export.updated',
    workspaceId: input.workspaceId,
    payload: { exportJobId: job.id, status: job.status, format: job.format },
  });

  return job;
}

/** Executed by the export worker so large files never block a request. */
export async function runExport(exportJobId: string): Promise<void> {
  const started = Date.now();
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (!job) return;

  await prisma.exportJob.update({ where: { id: job.id }, data: { status: ExportStatus.RUNNING } });
  await publishEvent({
    type: 'export.updated',
    workspaceId: job.workspaceId,
    payload: { exportJobId: job.id, status: ExportStatus.RUNNING },
  });

  try {
    const options = (job.options as Record<string, unknown> | null) ?? {};
    const projection = Array.isArray(options.columns)
      ? options.columns.filter((c): c is string => typeof c === 'string')
      : undefined;
    const dataset = await loadDataset(job.compilationId, projection);
    const generated = await generateExport(job.format, dataset);
    const storageKey = buildStorageKey({
      workspaceId: job.workspaceId,
      kind: 'export',
      id: job.reference,
      extension: generated.extension,
    });
    await putObject(storageKey, generated.buffer, generated.contentType);

    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        status: ExportStatus.COMPLETED,
        storageKey,
        sizeBytes: BigInt(generated.buffer.byteLength),
        rowCount: generated.rowCount,
        durationMs: Date.now() - started,
      },
    });
    await publishEvent({
      type: 'export.updated',
      workspaceId: job.workspaceId,
      payload: {
        exportJobId: job.id,
        status: ExportStatus.COMPLETED,
        rowCount: generated.rowCount,
        format: job.format,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    await prisma.exportJob.update({
      where: { id: job.id },
      data: { status: ExportStatus.FAILED, error: message.slice(0, 1000), durationMs: Date.now() - started },
    });
    await publishEvent({
      type: 'export.updated',
      workspaceId: job.workspaceId,
      payload: { exportJobId: job.id, status: ExportStatus.FAILED, error: message },
    });
  }
}

export async function getDownloadUrl(workspaceId: string, exportJobId: string): Promise<string> {
  const job = await prisma.exportJob.findFirst({ where: { id: exportJobId, workspaceId } });
  if (!job || !job.storageKey) throw notFound('Export file is not available');
  return presignGet(job.storageKey, 900);
}
