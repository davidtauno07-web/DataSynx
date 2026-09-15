import { Router } from 'express';
import { z } from 'zod';
import { ExportFormat } from '@prisma/client';
import { prisma, serialize } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { apiLimiter } from '../../middleware/rateLimit.js';
import { recordAudit, requestContext } from '../audit/service.js';
import { listCompilations, listRecords } from '../compilation/service.js';
import { getDownloadUrl, queueExport } from './service.js';

export const exportRouter = Router();
exportRouter.use(requireAuth, apiLimiter);

exportRouter.get(
  '/compilations',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    res.json({ compilations: serialize(await listCompilations(auth.workspaceId)) });
  }),
);

exportRouter.get(
  '/compilations/:compilationId/records',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { compilationId } = z.object({ compilationId: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(1).max(200).default(50),
        includeRemoved: z.coerce.boolean().default(false),
      })
      .parse(req.query);

    const result = await listRecords({
      workspaceId: auth.workspaceId,
      compilationId,
      page: query.page,
      pageSize: query.pageSize,
      includeRemoved: query.includeRemoved,
    });
    if (!result) throw notFound('Compilation not found');
    res.json(serialize({ ...result, page: query.page, pageSize: query.pageSize }));
  }),
);

const createExportSchema = z.object({
  compilationId: z.string().uuid(),
  format: z.nativeEnum(ExportFormat),
  options: z.record(z.unknown()).optional(),
});

exportRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = createExportSchema.parse(req.body);
    const job = await queueExport({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      compilationId: body.compilationId,
      format: body.format,
      options: body.options,
    });
    await recordAudit({
      ...requestContext(req),
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'export.queued',
      entityType: 'ExportJob',
      entityId: job.id,
      after: { format: body.format },
    });
    res.status(202).json(serialize({ export: job }));
  }),
);

exportRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const jobs = await prisma.exportJob.findMany({
      where: { workspaceId: auth.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { compilation: { select: { name: true, modality: true } } },
    });
    res.json({ exports: serialize(jobs) });
  }),
);

exportRouter.get(
  '/:exportId/download',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { exportId } = z.object({ exportId: z.string().uuid() }).parse(req.params);
    res.json({ url: await getDownloadUrl(auth.workspaceId, exportId) });
  }),
);
