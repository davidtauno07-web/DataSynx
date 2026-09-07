import { ItemStatus, JobStatus, type ProcessingJob } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nextJobReference } from '../../lib/references.js';
import { getProcessingQueue } from '../../queue/queues.js';
import { publishEvent } from '../../events/bus.js';
import { toJson } from '../../lib/json.js';

export interface CreateJobInput {
  workspaceId: string;
  userId: string;
  name: string;
  fileIds: string[];
  importId?: string;
  options?: Record<string, unknown>;
}

export async function createJob(input: CreateJobInput): Promise<ProcessingJob> {
  if (input.fileIds.length === 0) throw badRequest('Select at least one file to process');

  const files = await prisma.fileObject.findMany({
    where: { id: { in: input.fileIds }, workspaceId: input.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  if (files.length !== input.fileIds.length) {
    throw notFound('One or more selected files could not be found in this workspace');
  }

  const job = await prisma.processingJob.create({
    data: {
      reference: await nextJobReference(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      importId: input.importId,
      name: input.name,
      totalItems: files.length,
      options: toJson(input.options),
      items: {
        create: files.map((file, index) => ({
          fileId: file.id,
          position: index + 1,
          modality: file.modality,
          status: ItemStatus.QUEUED,
        })),
      },
    },
    include: { items: true },
  });

  const queue = getProcessingQueue();
  await queue.addBulk(
    job.items
      .sort((a, b) => a.position - b.position)
      .map((item) => ({
        name: 'process-item',
        data: { itemId: item.id, jobId: job.id, workspaceId: job.workspaceId },
        opts: { jobId: `item-${item.id}` },
      })),
  );

  await publishEvent({
    type: 'job.updated',
    workspaceId: job.workspaceId,
    jobId: job.id,
    payload: { status: job.status, totalItems: job.totalItems, doneItems: 0, failedItems: 0 },
  });

  return job;
}

export async function cancelJob(workspaceId: string, jobId: string): Promise<void> {
  const job = await prisma.processingJob.findFirst({ where: { id: jobId, workspaceId } });
  if (!job) throw notFound('Processing job not found');

  const items = await prisma.processingItem.findMany({
    where: { jobId, status: { in: [ItemStatus.QUEUED, ItemStatus.IMPORTED] } },
    select: { id: true },
  });

  const queue = getProcessingQueue();
  await Promise.all(
    items.map(async (item) => {
      const queued = await queue.getJob(`item-${item.id}`);
      await queued?.remove().catch(() => undefined);
    }),
  );

  await prisma.$transaction([
    prisma.processingItem.updateMany({
      where: { jobId, status: { in: [ItemStatus.QUEUED, ItemStatus.IMPORTED] } },
      data: { status: ItemStatus.CANCELLED },
    }),
    prisma.processingJob.update({
      where: { id: jobId },
      data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
    }),
  ]);

  await publishEvent({
    type: 'job.updated',
    workspaceId,
    jobId,
    payload: { status: JobStatus.CANCELLED },
  });
}

/** Requeues only the failed items — successful results are never discarded. */
export async function retryFailedItems(workspaceId: string, jobId: string): Promise<number> {
  const job = await prisma.processingJob.findFirst({ where: { id: jobId, workspaceId } });
  if (!job) throw notFound('Processing job not found');

  const failed = await prisma.processingItem.findMany({
    where: { jobId, status: ItemStatus.FAILED },
    select: { id: true },
  });
  if (failed.length === 0) return 0;

  await prisma.$transaction([
    prisma.processingItem.updateMany({
      where: { id: { in: failed.map((f) => f.id) } },
      data: { status: ItemStatus.QUEUED, error: null, progress: 0, stage: null },
    }),
    prisma.processingJob.update({
      where: { id: jobId },
      data: { status: JobStatus.QUEUED, failedItems: 0, finishedAt: null },
    }),
  ]);

  const queue = getProcessingQueue();
  await queue.addBulk(
    failed.map((item) => ({
      name: 'process-item',
      data: { itemId: item.id, jobId, workspaceId },
      opts: { jobId: `item-${item.id}-${Date.now()}` },
    })),
  );

  return failed.length;
}
