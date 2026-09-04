import { ItemStatus, JobStatus, ResultOrigin } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { presignGet } from '../lib/storage.js';
import { publishEvent } from '../events/bus.js';
import { getProcessor } from '../processors/index.js';
import { upsertCompilationRows } from '../modules/compilation/service.js';
import type { ProcessItemJob } from '../queue/queues.js';

async function setStage(
  itemId: string,
  workspaceId: string,
  jobId: string,
  status: ItemStatus,
  stage: string,
  progress: number,
): Promise<void> {
  await prisma.processingItem.update({
    where: { id: itemId },
    data: { status, stage, progress },
  });
  await publishEvent({
    type: 'item.updated',
    workspaceId,
    jobId,
    itemId,
    payload: { status, stage, progress },
  });
}

async function refreshJobStatus(jobId: string, workspaceId: string): Promise<void> {
  const [job, counts] = await Promise.all([
    prisma.processingJob.findUnique({ where: { id: jobId } }),
    prisma.processingItem.groupBy({ by: ['status'], where: { jobId }, _count: true }),
  ]);
  if (!job) return;

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<
    ItemStatus,
    number | undefined
  >;
  const done = byStatus.COMPLETED ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const cancelled = byStatus.CANCELLED ?? 0;
  const settled = done + failed + cancelled;

  const status: JobStatus =
    settled < job.totalItems
      ? JobStatus.RUNNING
      : failed === 0
        ? JobStatus.COMPLETED
        : done > 0
          ? JobStatus.COMPLETED_WITH_ERRORS
          : JobStatus.FAILED;

  const updated = await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status,
      doneItems: done,
      failedItems: failed,
      startedAt: job.startedAt ?? new Date(),
      finishedAt: settled >= job.totalItems ? new Date() : null,
    },
  });

  await publishEvent({
    type: 'job.updated',
    workspaceId,
    jobId,
    payload: {
      status: updated.status,
      totalItems: updated.totalItems,
      doneItems: updated.doneItems,
      failedItems: updated.failedItems,
    },
  });
}

/**
 * Runs one item end to end: preprocess -> specialised engine -> structure ->
 * compile. A failure here is contained to this item; the rest of the batch
 * continues.
 */
export async function processItem(data: ProcessItemJob): Promise<void> {
  const started = Date.now();
  const item = await prisma.processingItem.findUnique({
    where: { id: data.itemId },
    include: { file: true, job: true },
  });
  if (!item) {
    logger.warn({ itemId: data.itemId }, 'processing item vanished');
    return;
  }
  if (item.status === ItemStatus.CANCELLED) return;

  await prisma.processingItem.update({
    where: { id: item.id },
    data: { startedAt: new Date(), attempts: { increment: 1 }, error: null },
  });

  try {
    await setStage(item.id, data.workspaceId, data.jobId, ItemStatus.PREPROCESSING, 'Preprocessing', 5);

    const processor = getProcessor(item.modality);
    const fileUrl = await presignGet(item.file.storageKey, 3600);

    await setStage(item.id, data.workspaceId, data.jobId, ItemStatus.PROCESSING, processor.name, 15);

    const output = await processor.process({
      file: item.file,
      fileUrl,
      options: (item.job.options as Record<string, unknown>) ?? {},
      onStage: (stage, progress) =>
        setStage(item.id, data.workspaceId, data.jobId, ItemStatus.PROCESSING, stage, progress),
    });

    await setStage(item.id, data.workspaceId, data.jobId, ItemStatus.STRUCTURING, 'Structuring', 92);

    const previous = await prisma.processingResult.findFirst({
      where: { itemId: item.id },
      orderBy: { version: 'desc' },
    });

    const result = await prisma.processingResult.create({
      data: {
        itemId: item.id,
        version: (previous?.version ?? 0) + 1,
        origin: previous ? ResultOrigin.REPROCESS : ResultOrigin.INITIAL,
        supersedesId: previous?.id ?? null,
        engine: output.engine,
        engineVersion: output.engineVersion,
        demo: output.demo,
        data: output.summary as Prisma.InputJsonValue,
        measurements: output.measurements as unknown as Prisma.InputJsonValue,
        warnings: output.warnings as unknown as Prisma.InputJsonValue,
        confidence: output.confidence,
      },
    });

    await setStage(item.id, data.workspaceId, data.jobId, ItemStatus.COMPILED, 'Compiling', 97);

    await upsertCompilationRows({
      workspaceId: data.workspaceId,
      modality: item.modality,
      result,
      sourceRef: item.file.reference,
      columns: output.compilation.columns,
      rows: output.compilation.rows,
    });

    const durationMs = Date.now() - started;
    await prisma.processingItem.update({
      where: { id: item.id },
      data: {
        status: ItemStatus.COMPLETED,
        stage: 'Completed',
        progress: 100,
        finishedAt: new Date(),
        durationMs,
      },
    });

    await publishEvent({
      type: 'item.completed',
      workspaceId: data.workspaceId,
      jobId: data.jobId,
      itemId: item.id,
      payload: {
        resultId: result.id,
        engine: result.engine,
        demo: result.demo,
        durationMs,
        fileReference: item.file.reference,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown processing error';
    logger.error({ err, itemId: item.id, file: item.file.reference }, 'item processing failed');

    await prisma.processingItem.update({
      where: { id: item.id },
      data: {
        status: ItemStatus.FAILED,
        stage: 'Failed',
        error: message.slice(0, 1000),
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      },
    });
    await publishEvent({
      type: 'item.updated',
      workspaceId: data.workspaceId,
      jobId: data.jobId,
      itemId: item.id,
      payload: { status: ItemStatus.FAILED, error: message, fileReference: item.file.reference },
    });
  } finally {
    await refreshJobStatus(data.jobId, data.workspaceId);
  }
}
