import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ImportSource, Modality } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma, serialize } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { presignGet } from '../../lib/storage.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { apiLimiter, uploadLimiter } from '../../middleware/rateLimit.js';
import { recordAudit, requestContext } from '../audit/service.js';
import { createImport, ingestFile } from '../ingestion/service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 200 },
});

export const importRouter = Router();
importRouter.use(requireAuth);

const uploadBodySchema = z.object({
  label: z.string().max(200).optional(),
  source: z.nativeEnum(ImportSource).default(ImportSource.MANUAL_UPLOAD),
  modality: z.nativeEnum(Modality).optional(),
});

importRouter.post(
  '/upload',
  uploadLimiter,
  upload.array('files', 200),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw badRequest('No files were uploaded');

    const body = uploadBodySchema.parse(req.body ?? {});
    const record = await createImport({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      source: body.source,
      label: body.label ?? `${files.length} file(s)`,
    });

    const accepted: unknown[] = [];
    const rejected: { originalName: string; error: string }[] = [];

    // A rejected file never aborts the batch.
    for (const file of files) {
      try {
        const { file: stored, duplicateOf } = await ingestFile({
          workspaceId: auth.workspaceId,
          userId: auth.sub,
          importId: record.id,
          file,
          modalityOverride: body.modality,
          hint: body.source === ImportSource.VOICE_RECORDER ? 'voice' : undefined,
        });
        accepted.push({
          id: stored.id,
          reference: stored.reference,
          originalName: stored.originalName,
          modality: stored.modality,
          sizeBytes: Number(stored.sizeBytes),
          scanStatus: stored.scanStatus,
          duplicateOf,
        });
      } catch (err) {
        rejected.push({
          originalName: file.originalname,
          error: err instanceof Error ? err.message : 'Upload rejected',
        });
      }
    }

    await recordAudit({
      ...requestContext(req),
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'import.upload',
      entityType: 'Import',
      entityId: record.id,
      after: { accepted: accepted.length, rejected: rejected.length },
    });

    res.status(201).json({
      import: { id: record.id, reference: record.reference, source: record.source },
      files: accepted,
      rejected,
    });
  }),
);

const voiceSchema = z.object({
  label: z.string().max(200).optional(),
  durationMs: z.coerce.number().int().nonnegative().optional(),
});

/** Voice recordings arrive as a single blob and are preserved verbatim. */
importRouter.post(
  '/voice',
  uploadLimiter,
  upload.single('recording'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const file = req.file;
    if (!file) throw badRequest('No recording was uploaded');
    const body = voiceSchema.parse(req.body ?? {});

    const record = await createImport({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      source: ImportSource.VOICE_RECORDER,
      label: body.label ?? 'Voice recording',
      metadata: { durationMs: body.durationMs ?? null },
    });

    const { file: stored } = await ingestFile({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      importId: record.id,
      hint: 'voice',
      modalityOverride: Modality.AUDIO,
      file: {
        originalname: file.originalname || `recording-${Date.now()}.webm`,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      },
      metadata: { durationMs: body.durationMs ?? null, capturedInBrowser: true },
    });

    await recordAudit({
      ...requestContext(req),
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'import.voice',
      entityType: 'FileObject',
      entityId: stored.id,
    });

    res.status(201).json({
      import: { id: record.id, reference: record.reference },
      file: {
        id: stored.id,
        reference: stored.reference,
        originalName: stored.originalName,
        modality: stored.modality,
        sizeBytes: Number(stored.sizeBytes),
      },
    });
  }),
);

importRouter.get(
  '/',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const query = z
      .object({ page: z.coerce.number().min(1).default(1), pageSize: z.coerce.number().min(1).max(100).default(20) })
      .parse(req.query);

    const [total, imports] = await prisma.$transaction([
      prisma.import.count({ where: { workspaceId: auth.workspaceId } }),
      prisma.import.findMany({
        where: { workspaceId: auth.workspaceId },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { files: true } } },
      }),
    ]);

    res.json({ total, page: query.page, pageSize: query.pageSize, imports: serialize(imports) });
  }),
);

importRouter.get(
  '/files',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const query = z
      .object({
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(1).max(200).default(50),
        modality: z.nativeEnum(Modality).optional(),
        importId: z.string().uuid().optional(),
        unprocessed: z.coerce.boolean().optional(),
      })
      .parse(req.query);

    const where = {
      workspaceId: auth.workspaceId,
      ...(query.modality ? { modality: query.modality } : {}),
      ...(query.importId ? { importId: query.importId } : {}),
      ...(query.unprocessed ? { items: { none: {} } } : {}),
    };

    const [total, files] = await prisma.$transaction([
      prisma.fileObject.count({ where }),
      prisma.fileObject.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          reference: true,
          originalName: true,
          modality: true,
          mimeType: true,
          sizeBytes: true,
          scanStatus: true,
          duplicateOfId: true,
          createdAt: true,
          import: { select: { id: true, reference: true, source: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

    res.json({ total, page: query.page, pageSize: query.pageSize, files: serialize(files) });
  }),
);

/** Short-lived presigned link to the untouched original. */
importRouter.get(
  '/files/:fileId/source',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { fileId } = z.object({ fileId: z.string().uuid() }).parse(req.params);
    const file = await prisma.fileObject.findFirst({
      where: { id: fileId, workspaceId: auth.workspaceId },
    });
    if (!file) throw notFound('File not found');
    res.json({
      url: await presignGet(file.storageKey, 900),
      mimeType: file.detectedMime ?? file.mimeType,
      originalName: file.originalName,
      modality: file.modality,
      metadata: file.metadata,
    });
  }),
);
