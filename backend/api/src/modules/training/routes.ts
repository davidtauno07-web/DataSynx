import { Router } from 'express';
import { z } from 'zod';
import { CorrectionStatus, Modality } from '@prisma/client';
import { serialize } from '../../lib/prisma.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { apiLimiter } from '../../middleware/rateLimit.js';
import { recordAudit, requestContext } from '../audit/service.js';
import {
  activateModel,
  buildDatasetVersion,
  createDataset,
  listCorrections,
  listDatasets,
  listModels,
  recordCorrection,
  recordEvaluation,
  registerModel,
  reviewCorrection,
} from './service.js';

export const trainingRouter = Router();
trainingRouter.use(requireAuth, apiLimiter);

const correctionSchema = z.object({
  resultId: z.string().uuid(),
  field: z.string().min(1).max(200),
  correctedValue: z.unknown(),
  rowKey: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
});

trainingRouter.post(
  '/corrections',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = correctionSchema.parse(req.body);
    const correction = await recordCorrection({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      resultId: body.resultId,
      field: body.field,
      correctedValue: body.correctedValue as never,
      rowKey: body.rowKey,
      note: body.note,
    });
    await recordAudit({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'training.correction.created',
      entityType: 'Correction',
      entityId: correction.id,
      ...requestContext(req),
    });
    res.status(201).json(serialize({ correction }));
  }),
);

trainingRouter.get(
  '/corrections',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const query = z
      .object({
        modality: z.nativeEnum(Modality).optional(),
        status: z.nativeEnum(CorrectionStatus).optional(),
        resultId: z.string().uuid().optional(),
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(1).max(200).default(50),
      })
      .parse(req.query);
    res.json(serialize(await listCorrections({ workspaceId: auth.workspaceId, ...query })));
  }),
);

trainingRouter.patch(
  '/corrections/:correctionId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { correctionId } = z.object({ correctionId: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.nativeEnum(CorrectionStatus) }).parse(req.body);
    const correction = await reviewCorrection({ workspaceId: auth.workspaceId, correctionId, status });
    res.json(serialize({ correction }));
  }),
);

trainingRouter.post(
  '/datasets',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = z
      .object({
        name: z.string().min(1).max(120),
        modality: z.nativeEnum(Modality),
        description: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const dataset = await createDataset({ workspaceId: auth.workspaceId, ...body });
    res.status(201).json(serialize({ dataset }));
  }),
);

trainingRouter.get(
  '/datasets',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    res.json(serialize({ datasets: await listDatasets(auth.workspaceId) }));
  }),
);

trainingRouter.post(
  '/datasets/:datasetId/versions',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(req.params);
    const { notes } = z.object({ notes: z.string().max(2000).optional() }).parse(req.body ?? {});
    const version = await buildDatasetVersion({ workspaceId: auth.workspaceId, datasetId, notes });
    await recordAudit({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'training.dataset.version.created',
      entityType: 'DatasetVersion',
      entityId: version.id,
      ...requestContext(req),
    });
    res.status(201).json(serialize({ version }));
  }),
);

trainingRouter.get(
  '/models',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { modality } = z.object({ modality: z.nativeEnum(Modality).optional() }).parse(req.query);
    res.json(serialize({ models: await listModels(auth.workspaceId, modality) }));
  }),
);

trainingRouter.post(
  '/models',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = z
      .object({
        modality: z.nativeEnum(Modality),
        name: z.string().min(1).max(120),
        version: z.string().min(1).max(60),
        provider: z.string().min(1).max(60),
        baseModel: z.string().max(200).optional(),
        artifactUri: z.string().max(500).optional(),
        trainedFromId: z.string().uuid().optional(),
        parameters: z.record(z.unknown()).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const model = await registerModel({
      workspaceId: auth.workspaceId,
      ...body,
      parameters: body.parameters as never,
    });
    res.status(201).json(serialize({ model }));
  }),
);

trainingRouter.post(
  '/models/:modelVersionId/activate',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { modelVersionId } = z.object({ modelVersionId: z.string().uuid() }).parse(req.params);
    const model = await activateModel({ workspaceId: auth.workspaceId, modelVersionId });
    await recordAudit({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'training.model.activated',
      entityType: 'ModelVersion',
      entityId: model.id,
      ...requestContext(req),
    });
    res.json(serialize({ model }));
  }),
);

trainingRouter.post(
  '/models/:modelVersionId/evaluations',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { modelVersionId } = z.object({ modelVersionId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        datasetVersionId: z.string().uuid(),
        metrics: z.record(z.number()),
        itemCount: z.number().int().min(0).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const evaluation = await recordEvaluation({
      workspaceId: auth.workspaceId,
      modelVersionId,
      ...body,
    });
    res.status(201).json(serialize({ evaluation }));
  }),
);
