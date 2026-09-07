/**
 * Training architecture: human corrections become versioned datasets, datasets
 * train model versions, and one model version per modality is active.
 *
 * Corrections never mutate a stored processing result — the original output is
 * evidence and stays intact.
 */
import {
  CorrectionStatus,
  DatasetStatus,
  ModelStage,
  Modality,
  Prisma,
  type Correction,
  type DatasetVersion,
  type ModelVersion,
  type TrainingDataset,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

export interface CorrectionInput {
  workspaceId: string;
  userId: string;
  resultId: string;
  field: string;
  correctedValue: Prisma.InputJsonValue;
  rowKey?: string;
  note?: string;
}

export async function recordCorrection(input: CorrectionInput): Promise<Correction> {
  const result = await prisma.processingResult.findFirst({
    where: { id: input.resultId, item: { job: { workspaceId: input.workspaceId } } },
    include: { item: true },
  });
  if (!result) throw notFound('Processing result not found');

  const data = result.data as Record<string, unknown> | null;
  const original = data && input.field in data ? (data[input.field] as Prisma.InputJsonValue) : undefined;

  return prisma.correction.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      resultId: input.resultId,
      rowKey: input.rowKey ?? null,
      modality: result.item.modality,
      field: input.field,
      originalValue: original,
      correctedValue: input.correctedValue,
      note: input.note ?? null,
    },
  });
}

export async function listCorrections(params: {
  workspaceId: string;
  modality?: Modality;
  status?: CorrectionStatus;
  resultId?: string;
  page: number;
  pageSize: number;
}): Promise<{ total: number; corrections: Correction[] }> {
  const where = {
    workspaceId: params.workspaceId,
    ...(params.modality ? { modality: params.modality } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.resultId ? { resultId: params.resultId } : {}),
  };
  const [total, corrections] = await Promise.all([
    prisma.correction.count({ where }),
    prisma.correction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
  ]);
  return { total, corrections };
}

export async function reviewCorrection(params: {
  workspaceId: string;
  correctionId: string;
  status: CorrectionStatus;
}): Promise<Correction> {
  const existing = await prisma.correction.findFirst({
    where: { id: params.correctionId, workspaceId: params.workspaceId },
  });
  if (!existing) throw notFound('Correction not found');
  return prisma.correction.update({ where: { id: existing.id }, data: { status: params.status } });
}

export async function createDataset(params: {
  workspaceId: string;
  modality: Modality;
  name: string;
  description?: string;
}): Promise<TrainingDataset> {
  const existing = await prisma.trainingDataset.findFirst({
    where: { workspaceId: params.workspaceId, name: params.name },
  });
  if (existing) throw conflict('A dataset with this name already exists');
  return prisma.trainingDataset.create({
    data: {
      workspaceId: params.workspaceId,
      modality: params.modality,
      name: params.name,
      description: params.description ?? null,
    },
  });
}

export function listDatasets(workspaceId: string) {
  return prisma.trainingDataset.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 5 } },
  });
}

/**
 * Freezes every accepted correction that is not already in a version into a new
 * immutable dataset version. Deterministic hold-out: every fifth item is `eval`.
 */
export async function buildDatasetVersion(params: {
  workspaceId: string;
  datasetId: string;
  notes?: string;
}): Promise<DatasetVersion> {
  const dataset = await prisma.trainingDataset.findFirst({
    where: { id: params.datasetId, workspaceId: params.workspaceId },
  });
  if (!dataset) throw notFound('Dataset not found');

  const corrections = await prisma.correction.findMany({
    where: {
      workspaceId: params.workspaceId,
      modality: dataset.modality,
      status: CorrectionStatus.ACCEPTED,
      items: { none: {} },
    },
    include: { result: { include: { item: { include: { file: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  if (corrections.length === 0) {
    throw badRequest('There are no new accepted corrections to build a dataset version from');
  }

  const last = await prisma.datasetVersion.findFirst({
    where: { datasetId: dataset.id },
    orderBy: { version: 'desc' },
  });

  return prisma.datasetVersion.create({
    data: {
      datasetId: dataset.id,
      version: (last?.version ?? 0) + 1,
      status: DatasetStatus.READY,
      itemCount: corrections.length,
      notes: params.notes ?? null,
      items: {
        create: corrections.map((correction, index) => ({
          correctionId: correction.id,
          fileId: correction.result.item.fileId,
          sourceRef: correction.result.item.file.reference,
          split: index % 5 === 4 ? 'eval' : 'train',
          input: {
            field: correction.field,
            original: correction.originalValue ?? null,
            resultId: correction.resultId,
            rowKey: correction.rowKey,
          },
          label: { value: correction.correctedValue },
        })),
      },
    },
  });
}

export async function registerModel(params: {
  workspaceId: string;
  modality: Modality;
  name: string;
  version: string;
  provider: string;
  baseModel?: string;
  artifactUri?: string;
  trainedFromId?: string;
  parameters?: Prisma.InputJsonValue;
  notes?: string;
}): Promise<ModelVersion> {
  if (params.trainedFromId) {
    const source = await prisma.datasetVersion.findFirst({
      where: { id: params.trainedFromId, dataset: { workspaceId: params.workspaceId } },
    });
    if (!source) throw notFound('Dataset version not found');
  }
  const duplicate = await prisma.modelVersion.findFirst({
    where: {
      workspaceId: params.workspaceId,
      modality: params.modality,
      name: params.name,
      version: params.version,
    },
  });
  if (duplicate) throw conflict('This model version is already registered');

  return prisma.modelVersion.create({
    data: {
      workspaceId: params.workspaceId,
      modality: params.modality,
      name: params.name,
      version: params.version,
      provider: params.provider,
      baseModel: params.baseModel ?? null,
      artifactUri: params.artifactUri ?? null,
      trainedFromId: params.trainedFromId ?? null,
      parameters: params.parameters ?? {},
      notes: params.notes ?? null,
    },
  });
}

export function listModels(workspaceId: string, modality?: Modality) {
  return prisma.modelVersion.findMany({
    where: { workspaceId, ...(modality ? { modality } : {}) },
    orderBy: [{ modality: 'asc' }, { createdAt: 'desc' }],
    include: { evaluations: { orderBy: { createdAt: 'desc' }, take: 3 } },
  });
}

/** Activating a model retires the previously active one for that modality. */
export async function activateModel(params: {
  workspaceId: string;
  modelVersionId: string;
}): Promise<ModelVersion> {
  const model = await prisma.modelVersion.findFirst({
    where: { id: params.modelVersionId, workspaceId: params.workspaceId },
  });
  if (!model) throw notFound('Model version not found');

  const [, activated] = await prisma.$transaction([
    prisma.modelVersion.updateMany({
      where: {
        workspaceId: params.workspaceId,
        modality: model.modality,
        stage: ModelStage.ACTIVE,
        id: { not: model.id },
      },
      data: { stage: ModelStage.RETIRED },
    }),
    prisma.modelVersion.update({
      where: { id: model.id },
      data: { stage: ModelStage.ACTIVE, activatedAt: new Date() },
    }),
  ]);
  return activated;
}

export function activeModelFor(workspaceId: string, modality: Modality) {
  return prisma.modelVersion.findFirst({
    where: { workspaceId, modality, stage: ModelStage.ACTIVE },
  });
}

/** Stores measured evaluation metrics; nothing is inferred when none are supplied. */
export async function recordEvaluation(params: {
  workspaceId: string;
  modelVersionId: string;
  datasetVersionId: string;
  metrics: Prisma.InputJsonValue;
  itemCount?: number;
  notes?: string;
}) {
  const model = await prisma.modelVersion.findFirst({
    where: { id: params.modelVersionId, workspaceId: params.workspaceId },
  });
  if (!model) throw notFound('Model version not found');
  const datasetVersion = await prisma.datasetVersion.findFirst({
    where: { id: params.datasetVersionId, dataset: { workspaceId: params.workspaceId } },
  });
  if (!datasetVersion) throw notFound('Dataset version not found');

  const evaluation = await prisma.evaluationRun.create({
    data: {
      modelVersionId: model.id,
      datasetVersionId: datasetVersion.id,
      metrics: params.metrics,
      itemCount: params.itemCount ?? datasetVersion.itemCount,
      notes: params.notes ?? null,
    },
  });
  await prisma.modelVersion.update({ where: { id: model.id }, data: { metrics: params.metrics } });
  return evaluation;
}
