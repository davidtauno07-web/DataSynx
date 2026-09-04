import { Router } from 'express';
import { z } from 'zod';
import { Modality } from '@prisma/client';
import { prisma, serialize } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { apiLimiter, commandLimiter } from '../../middleware/rateLimit.js';
import { subscribeEvents } from '../../events/bus.js';
import { aiClient } from '../../services/ai/client.js';
import { recordAudit, requestContext } from '../audit/service.js';
import { cancelJob, createJob, retryFailedItems } from '../jobs/service.js';
import { runCommand } from '../commands/service.js';

export const processingRouter = Router();
processingRouter.use(requireAuth);

const createJobSchema = z.object({
  name: z.string().trim().min(1).max(200).default('Processing job'),
  fileIds: z.array(z.string().uuid()).min(1).max(1000),
  importId: z.string().uuid().optional(),
  options: z.record(z.unknown()).optional(),
});

processingRouter.post(
  '/jobs',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = createJobSchema.parse(req.body);
    const job = await createJob({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      name: body.name,
      fileIds: body.fileIds,
      importId: body.importId,
      options: body.options,
    });
    await recordAudit({
      ...requestContext(req),
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'job.created',
      entityType: 'ProcessingJob',
      entityId: job.id,
      after: { files: body.fileIds.length },
    });
    res.status(201).json(serialize({ job }));
  }),
);

processingRouter.get(
  '/jobs',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const query = z
      .object({ page: z.coerce.number().min(1).default(1), pageSize: z.coerce.number().min(1).max(50).default(20) })
      .parse(req.query);

    const [total, jobs] = await prisma.$transaction([
      prisma.processingJob.count({ where: { workspaceId: auth.workspaceId } }),
      prisma.processingJob.findMany({
        where: { workspaceId: auth.workspaceId },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    res.json({ total, jobs: serialize(jobs) });
  }),
);

processingRouter.get(
  '/jobs/:jobId',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
    const job = await prisma.processingJob.findFirst({
      where: { id: jobId, workspaceId: auth.workspaceId },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: {
            file: { select: { id: true, reference: true, originalName: true, modality: true, mimeType: true } },
          },
        },
      },
    });
    if (!job) throw notFound('Processing job not found');
    res.json(serialize({ job }));
  }),
);

/** Returns the single item the live panel should render right now. */
processingRouter.get(
  '/jobs/:jobId/current',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
    const job = await prisma.processingJob.findFirst({ where: { id: jobId, workspaceId: auth.workspaceId } });
    if (!job) throw notFound('Processing job not found');

    const active = await prisma.processingItem.findFirst({
      where: { jobId, status: { in: ['PREPROCESSING', 'PROCESSING', 'STRUCTURING', 'COMPILED'] } },
      orderBy: { position: 'asc' },
      include: { file: true, results: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const item =
      active ??
      (await prisma.processingItem.findFirst({
        where: { jobId },
        orderBy: [{ finishedAt: 'desc' }, { position: 'desc' }],
        include: { file: true, results: { orderBy: { version: 'desc' }, take: 1 } },
      }));

    res.json(
      serialize({
        job,
        item,
        result: item?.results[0] ?? null,
      }),
    );
  }),
);

processingRouter.get(
  '/items/:itemId',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(req.params);
    const item = await prisma.processingItem.findFirst({
      where: { id: itemId, job: { workspaceId: auth.workspaceId } },
      include: { file: true, results: { orderBy: { version: 'desc' } } },
    });
    if (!item) throw notFound('Processing item not found');
    res.json(serialize({ item, result: item.results[0] ?? null }));
  }),
);

processingRouter.post(
  '/jobs/:jobId/cancel',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
    await cancelJob(auth.workspaceId, jobId);
    await recordAudit({
      ...requestContext(req),
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'job.cancelled',
      entityType: 'ProcessingJob',
      entityId: jobId,
    });
    res.json({ ok: true });
  }),
);

processingRouter.post(
  '/jobs/:jobId/retry',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
    const retried = await retryFailedItems(auth.workspaceId, jobId);
    res.json({ retried });
  }),
);

const commandSchema = z.object({
  input: z.string().trim().min(1).max(2000),
  jobId: z.string().uuid().optional(),
  modality: z.nativeEnum(Modality).optional(),
});

processingRouter.post(
  '/commands',
  commandLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = commandSchema.parse(req.body);
    const result = await runCommand(body.input, {
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      jobId: body.jobId,
      modality: body.modality,
      ...requestContext(req),
    });
    res.json(result);
  }),
);

processingRouter.get(
  '/commands',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const commands = await prisma.processingCommand.findMany({
      where: { workspaceId: auth.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ commands: serialize(commands) });
  }),
);

processingRouter.get(
  '/capabilities',
  apiLimiter,
  asyncHandler(async (_req, res) => {
    res.json(await aiClient.capabilities());
  }),
);

/** Server-sent events: live processing progress for the current workspace. */
processingRouter.get('/stream', (req, res) => {
  const auth = authOf(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ workspaceId: auth.workspaceId })}\n\n`);

  const unsubscribe = subscribeEvents(auth.workspaceId, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});
