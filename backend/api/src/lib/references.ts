import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Human-readable, gap-free references such as DSX-2026-000001.
 * Allocated through an atomic upsert+increment so concurrent workers cannot
 * produce duplicates.
 */
export async function nextReference(prefix: string, db: Db = prisma, at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  const id = `${prefix}:${year}`;
  const row = await db.referenceCounter.upsert({
    where: { id },
    create: { id, current: 1 },
    update: { current: { increment: 1 } },
  });
  return `${prefix}-${year}-${String(row.current).padStart(6, '0')}`;
}

export const nextFileReference = (db?: Db) => nextReference('DSX', db);
export const nextImportReference = (db?: Db) => nextReference('IMP', db);
export const nextJobReference = (db?: Db) => nextReference('JOB', db);
export const nextExportReference = (db?: Db) => nextReference('EXP', db);
