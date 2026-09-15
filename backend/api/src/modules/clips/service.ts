import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClipStatus, type Prisma } from '@prisma/client';
import type { ClipSpec } from '../../domain/results.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { buildStorageKey, putObject } from '../../lib/storage.js';

/** Upper bound per result so one busy camera cannot fill the bucket. */
export const MAX_CLIPS_PER_RESULT = 60;
const FFMPEG_TIMEOUT_MS = 120_000;
const CLIP_MIME = 'video/mp4';

export interface ClipSource {
  workspaceId: string;
  resultId: string;
  fileId: string;
  sourceRef: string;
  /** Presigned read URL of the original media; the original is never modified. */
  fileUrl: string;
  engine: string;
  engineVersion: string;
}

/**
 * Cuts one window out of the source with a stream copy. Copying instead of
 * re-encoding keeps the clip's pixels identical to the original evidence.
 */
async function cut(fileUrl: string, start: number, duration: number, target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        start.toFixed(3),
        '-i',
        fileUrl,
        '-t',
        duration.toFixed(3),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        target,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? 'unknown'}`));
    });
  });
}

/**
 * Materialises the contextual clips an engine planned. A clip that cannot be
 * cut is still recorded, as UNAVAILABLE with the reason, so the evidence trail
 * shows the event and says honestly that its footage is missing.
 */
export async function generateEventClips(source: ClipSource, specs: ClipSpec[]): Promise<number> {
  if (specs.length === 0) return 0;
  const planned = specs.slice(0, MAX_CLIPS_PER_RESULT);
  const dir = await mkdtemp(join(tmpdir(), 'datasynx-clips-'));
  let stored = 0;

  try {
    for (const spec of planned) {
      const duration = Math.max(0, spec.endTime - spec.startTime);
      const base = {
        workspaceId: source.workspaceId,
        resultId: source.resultId,
        fileId: source.fileId,
        sourceRef: source.sourceRef,
        clipKey: spec.clipKey,
        subject: spec.subject,
        objectType: spec.objectType,
        sequence: spec.sequence,
        startTime: spec.startTime,
        endTime: spec.endTime,
        eventTime: spec.eventTime,
        kinds: spec.kinds as unknown as Prisma.InputJsonValue,
        events: spec.events as unknown as Prisma.InputJsonValue,
        reason: spec.reason,
        engine: source.engine,
        engineVersion: source.engineVersion,
      };

      if (duration <= 0) {
        await persist({ ...base, status: ClipStatus.UNAVAILABLE, unavailableReason: 'Empty clip window' });
        continue;
      }

      const target = join(dir, `${spec.clipKey}.mp4`);
      try {
        await cut(source.fileUrl, spec.startTime, duration, target);
        const { size } = await stat(target);
        const storageKey = buildStorageKey({
          workspaceId: source.workspaceId,
          kind: 'derived',
          id: `clips/${source.resultId}/${spec.clipKey}`,
          extension: 'mp4',
        });
        await putObject(storageKey, createReadStream(target), CLIP_MIME);
        await persist({
          ...base,
          status: ClipStatus.READY,
          storageKey,
          mimeType: CLIP_MIME,
          sizeBytes: BigInt(size),
        });
        stored += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Clip extraction failed';
        logger.warn({ err, clipKey: spec.clipKey, resultId: source.resultId }, 'event clip extraction failed');
        await persist({ ...base, status: ClipStatus.UNAVAILABLE, unavailableReason: reason.slice(0, 500) });
      } finally {
        await rm(target, { force: true });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  return stored;
}

export interface ClipQuery {
  workspaceId: string;
  resultId?: string;
  jobId?: string;
  subject?: string;
  kind?: string;
  limit?: number;
}

/** Chronological clip lookup, always scoped to the caller's workspace. */
export async function findClips(query: ClipQuery) {
  const where: Prisma.EventClipWhereInput = {
    workspaceId: query.workspaceId,
    ...(query.resultId ? { resultId: query.resultId } : {}),
    ...(query.jobId ? { result: { item: { jobId: query.jobId } } } : {}),
    ...(query.subject ? { subject: { contains: query.subject, mode: 'insensitive' } } : {}),
    ...(query.kind ? { kinds: { array_contains: [query.kind.toUpperCase()] } } : {}),
  };
  return prisma.eventClip.findMany({
    where,
    orderBy: [{ startTime: 'asc' }, { subject: 'asc' }],
    take: Math.min(query.limit ?? 100, MAX_CLIPS_PER_RESULT * 5),
  });
}

async function persist(data: Prisma.EventClipUncheckedCreateInput): Promise<void> {
  await prisma.eventClip.upsert({
    where: { resultId_clipKey: { resultId: data.resultId, clipKey: data.clipKey } },
    create: data,
    update: data,
  });
}
