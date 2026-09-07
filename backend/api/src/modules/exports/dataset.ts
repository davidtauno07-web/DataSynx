import type { Compilation, CompilationRecord } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';

export interface Dataset {
  compilation: Compilation;
  columns: string[];
  rows: Record<string, unknown>[];
  geometries: { properties: Record<string, unknown>; geometry: unknown }[];
  generatedAt: Date;
}

const BATCH = 1000;

/**
 * Restricts the exported columns to a `show only …` projection. Matching is
 * case-insensitive; unknown names are ignored and `Source` is always kept so a
 * row can still be traced back to its original file. An empty intersection
 * falls back to the full column set rather than exporting an empty sheet.
 */
function projectColumns(columns: string[], projection?: string[]): string[] {
  if (!projection || projection.length === 0) return columns;
  const wanted = new Set(projection.map((c) => c.trim().toLowerCase()));
  const kept = columns.filter((c) => c === 'Source' || wanted.has(c.toLowerCase()));
  return kept.length > 1 ? kept : columns;
}

/**
 * Exports always read the persisted compilation — the AI pipeline is never
 * re-run for an export.
 */
export async function loadDataset(
  compilationId: string,
  projection?: string[],
): Promise<Dataset> {
  const compilation = await prisma.compilation.findUnique({ where: { id: compilationId } });
  if (!compilation) throw notFound('Compilation not found');

  const columns = [...((compilation.columns as string[]) ?? [])];
  const rows: Record<string, unknown>[] = [];
  const geometries: Dataset['geometries'] = [];

  let cursor: string | undefined;
  for (;;) {
    const batch: CompilationRecord[] = await prisma.compilationRecord.findMany({
      where: { compilationId, removed: false },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;

    for (const record of batch) {
      const data = record.data as Record<string, unknown>;
      const row: Record<string, unknown> = { Source: record.sourceRef, ...data };
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
      rows.push(row);
      if (record.geometry) geometries.push({ properties: row, geometry: record.geometry });
    }

    cursor = batch[batch.length - 1]?.id;
    if (batch.length < BATCH) break;
  }

  if (!columns.includes('Source')) columns.unshift('Source');

  return {
    compilation,
    columns: projectColumns(columns, projection),
    rows,
    geometries,
    generatedAt: new Date(),
  };
}

export const cellToString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};
