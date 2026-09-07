import { randomUUID } from 'node:crypto';
import { ImportSource, Modality, ScanStatus, type FileObject } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sha256Hex } from '../../lib/crypto.js';
import { buildStorageKey, putObject } from '../../lib/storage.js';
import { nextFileReference, nextImportReference } from '../../lib/references.js';
import { unprocessable } from '../../lib/errors.js';
import { routeModality, type FileSignature } from '../../domain/modality.js';
import { logger } from '../../lib/logger.js';
import { expandArchive } from './archive.js';
import { validateUpload } from './validation.js';
import { scanBuffer } from './scanner.js';
import { toJson } from '../../lib/json.js';

export interface IngestInput {
  workspaceId: string;
  userId: string;
  importId: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  hint?: FileSignature['hint'];
  modalityOverride?: Modality;
  metadata?: Record<string, unknown>;
  /** Set when the file was extracted from a container. */
  archive?: { id: string; path: string };
}

export interface IngestedFile {
  file: FileObject;
  duplicateOf: string | null;
}

export async function createImport(input: {
  workspaceId: string;
  userId: string;
  source: ImportSource;
  label?: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.import.create({
    data: {
      reference: await nextImportReference(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      source: input.source,
      label: input.label,
      metadata: toJson(input.metadata),
    },
  });
}

/**
 * Stores the original object untouched, records its metadata, and routes it to
 * a pipeline. Duplicates are flagged, never removed.
 */
export async function ingestFile(input: IngestInput): Promise<IngestedFile> {
  const validated = await validateUpload(input.file);
  const checksum = sha256Hex(input.file.buffer);

  const scanStatus = await scanBuffer(input.file.buffer);
  if (scanStatus === ScanStatus.INFECTED) {
    throw unprocessable(`"${validated.originalName}" was rejected by malware scanning`);
  }

  const existing = await prisma.fileObject.findFirst({
    where: { workspaceId: input.workspaceId, checksumSha256: checksum },
    orderBy: { createdAt: 'asc' },
    select: { id: true, reference: true },
  });

  const modality =
    input.modalityOverride ??
    routeModality({
      originalName: validated.originalName,
      extension: validated.extension,
      declaredMime: validated.declaredMime,
      detectedMime: validated.detectedMime ?? undefined,
      sizeBytes: validated.sizeBytes,
      hint: input.hint,
    });

  const id = randomUUID();
  const storageKey = buildStorageKey({
    workspaceId: input.workspaceId,
    kind: 'original',
    id,
    extension: validated.extension,
  });

  await putObject(storageKey, input.file.buffer, validated.declaredMime);

  const file = await prisma.fileObject.create({
    data: {
      id,
      reference: await nextFileReference(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      importId: input.importId,
      originalName: validated.originalName,
      extension: validated.extension,
      mimeType: validated.declaredMime,
      detectedMime: validated.detectedMime,
      sizeBytes: BigInt(validated.sizeBytes),
      checksumSha256: checksum,
      storageKey,
      storageBucket: process.env.S3_BUCKET ?? 'datasynx',
      modality,
      metadata: toJson(input.metadata),
      scanStatus,
      duplicateOfId: existing?.id ?? null,
      archiveId: input.archive?.id ?? null,
      archivePath: input.archive?.path ?? null,
    },
  });

  logger.info(
    { file: file.reference, modality, duplicate: Boolean(existing) },
    'file ingested',
  );

  return { file, duplicateOf: existing?.reference ?? null };
}

export interface IngestedArchive {
  archive: FileObject;
  members: IngestedFile[];
  skipped: { archivePath: string; reason: string }[];
}

/**
 * A ZIP is stored untouched as its own record and every member is ingested
 * with lineage back to it. One unusable member never aborts the archive.
 */
export async function ingestArchive(input: {
  workspaceId: string;
  userId: string;
  importId: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
}): Promise<IngestedArchive> {
  const expansion = await expandArchive(input.file.buffer);

  const { file: archive } = await ingestFile({
    workspaceId: input.workspaceId,
    userId: input.userId,
    importId: input.importId,
    file: input.file,
    modalityOverride: Modality.ARCHIVE,
    metadata: {
      archive: {
        entryCount: expansion.members.length,
        skippedCount: expansion.skipped.length,
        extractedBytes: expansion.totalBytes,
      },
    },
  });

  const members: IngestedFile[] = [];
  const skipped = [...expansion.skipped];

  for (const member of expansion.members) {
    try {
      members.push(
        await ingestFile({
          workspaceId: input.workspaceId,
          userId: input.userId,
          importId: input.importId,
          file: {
            originalname: member.fileName,
            // Empty so validation trusts the sniffed signature, not the container.
            mimetype: '',
            size: member.sizeBytes,
            buffer: member.buffer,
          },
          archive: { id: archive.id, path: member.archivePath },
          metadata: { archivePath: member.archivePath, archiveReference: archive.reference },
        }),
      );
    } catch (err) {
      skipped.push({
        archivePath: member.archivePath,
        reason: err instanceof Error ? err.message : 'File rejected',
      });
    }
  }

  logger.info(
    { archive: archive.reference, extracted: members.length, skipped: skipped.length },
    'archive expanded',
  );

  return { archive, members, skipped };
}
