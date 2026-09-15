import { Modality, Prisma, type ProcessingResult } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { publishEvent } from '../../events/bus.js';
import type { CompilationRow } from '../../domain/results.js';
import { modalityLabel } from '../../domain/modality.js';

/**
 * The compilation engine is the persistent dataset behind the Export page.
 * Live processing panels come and go; every completed result lands here.
 */
export async function upsertCompilationRows(params: {
  workspaceId: string;
  modality: Modality;
  result: ProcessingResult;
  sourceRef: string;
  columns: string[];
  rows: CompilationRow[];
}): Promise<{ compilationId: string; recordCount: number }> {
  const { workspaceId, modality, result, sourceRef, columns, rows } = params;

  const compilation = await openCompilation(workspaceId, modality, columns);

  // Union the column set so later results can widen the table.
  const existingColumns = (compilation.columns as string[]) ?? [];
  const mergedColumns = [...existingColumns];
  for (const column of columns) if (!mergedColumns.includes(column)) mergedColumns.push(column);

  await prisma.$transaction(
    rows.map((row) =>
      prisma.compilationRecord.upsert({
        where: { compilationId_rowKey: { compilationId: compilation.id, rowKey: row.rowKey } },
        create: {
          compilationId: compilation.id,
          resultId: result.id,
          sourceRef,
          rowKey: row.rowKey,
          data: row.data as Prisma.InputJsonValue,
          geometry: (row.geometry ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        update: {
          resultId: result.id,
          data: row.data as Prisma.InputJsonValue,
          geometry: (row.geometry ?? undefined) as Prisma.InputJsonValue | undefined,
          removed: false,
        },
      }),
    ),
  );

  const recordCount = await prisma.compilationRecord.count({
    where: { compilationId: compilation.id, removed: false },
  });

  await prisma.compilation.update({
    where: { id: compilation.id },
    data: { columns: mergedColumns, recordCount },
  });

  await publishEvent({
    type: 'compilation.updated',
    workspaceId,
    payload: { compilationId: compilation.id, modality, recordCount },
  });

  return { compilationId: compilation.id, recordCount };
}

/**
 * Workers compile concurrently, so two items of the same modality can reach the
 * upsert before either has committed. Postgres resolves that with a unique
 * violation on (workspaceId, modality); the loser simply reads the winner's row.
 */
async function openCompilation(workspaceId: string, modality: Modality, columns: string[]) {
  try {
    return await prisma.compilation.upsert({
      where: { workspaceId_modality: { workspaceId, modality } },
      create: {
        workspaceId,
        modality,
        name: `${modalityLabel[modality]} compilation`,
        columns,
      },
      update: {},
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    return prisma.compilation.findUniqueOrThrow({
      where: { workspaceId_modality: { workspaceId, modality } },
    });
  }
}

export async function listCompilations(workspaceId: string) {
  return prisma.compilation.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function listRecords(params: {
  workspaceId: string;
  compilationId: string;
  page: number;
  pageSize: number;
  includeRemoved?: boolean;
}) {
  const compilation = await prisma.compilation.findFirst({
    where: { id: params.compilationId, workspaceId: params.workspaceId },
  });
  if (!compilation) return null;

  const where = {
    compilationId: compilation.id,
    ...(params.includeRemoved ? {} : { removed: false }),
  };
  const [total, records] = await prisma.$transaction([
    prisma.compilationRecord.count({ where }),
    prisma.compilationRecord.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
  ]);

  return { compilation, total, records };
}

/**
 * Rows are soft-removed only. Original files and results stay intact so an
 * exclusion can always be reversed and remains auditable.
 */
export async function setRecordsRemoved(params: {
  workspaceId: string;
  compilationId: string;
  rowKeys: string[];
  removed: boolean;
}): Promise<number> {
  const compilation = await prisma.compilation.findFirst({
    where: { id: params.compilationId, workspaceId: params.workspaceId },
  });
  if (!compilation) return 0;

  const { count } = await prisma.compilationRecord.updateMany({
    where: { compilationId: compilation.id, rowKey: { in: params.rowKeys } },
    data: { removed: params.removed },
  });

  const recordCount = await prisma.compilationRecord.count({
    where: { compilationId: compilation.id, removed: false },
  });
  await prisma.compilation.update({ where: { id: compilation.id }, data: { recordCount } });

  await publishEvent({
    type: 'compilation.updated',
    workspaceId: params.workspaceId,
    payload: { compilationId: compilation.id, recordCount },
  });

  return count;
}
