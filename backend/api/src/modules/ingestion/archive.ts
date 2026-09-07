/**
 * Secure ZIP expansion. A ZIP is a container, never a processing item: it is
 * stored untouched and every member is ingested as its own file with lineage
 * back to the archive.
 *
 * Hostile archives are rejected before anything is written: path traversal
 * ("zip slip"), absolute paths, symlinks, nested archives, too many entries,
 * excessive uncompressed size and implausible compression ratios (zip bombs).
 */
import { posix } from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { unprocessable } from '../../lib/errors.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 2_000,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 300,
};

export interface ArchiveMember {
  /** Sanitised path relative to the archive root, e.g. `invoices/march/01.pdf`. */
  archivePath: string;
  fileName: string;
  sizeBytes: number;
  buffer: Buffer;
}

export interface ArchiveSkip {
  archivePath: string;
  reason: string;
}

export interface ArchiveExpansion {
  members: ArchiveMember[];
  skipped: ArchiveSkip[];
  totalBytes: number;
}

const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'tgz']);
const UNIX_SYMLINK_MODE = 0o120000;

export function isArchiveName(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

/** Rejects traversal and absolute paths instead of silently rewriting them. */
export function safeArchivePath(rawPath: string): string | null {
  const normalised = rawPath.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:\//.test(normalised)) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
  if (/[\u0000-\u001f]/.test(normalised)) return null;
  const segments = normalised.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) return null;
  const joined = posix.join(...segments);
  if (joined.startsWith('..') || posix.isAbsolute(joined)) return null;
  return joined;
}

function isSymlink(entry: Entry): boolean {
  // High 16 bits of externalFileAttributes carry the Unix mode for entries
  // written on Unix hosts (version-made-by high byte 3).
  if (entry.versionMadeBy >> 8 !== 3) return false;
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === UNIX_SYMLINK_MODE;
}

/**
 * `decodeStrings: false` keeps yauzl from aborting the whole archive on the
 * first hostile filename: names are decoded and validated per entry here, so a
 * malicious entry is skipped while the safe files still import.
 */
function entryName(entry: Entry): string {
  const raw = entry.fileName as unknown;
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, decodeStrings: false }, (err, zip) => {
      if (err || !zip) {
        reject(unprocessable(`The archive could not be read: ${err?.message ?? 'unknown format'}`));
        return;
      }
      resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(unprocessable(`"${entryName(entry)}" could not be extracted`));
        return;
      }
      const chunks: Buffer[] = [];
      let read = 0;
      stream.on('data', (chunk: Buffer) => {
        read += chunk.length;
        // The declared size is attacker-controlled; enforce the ceiling on the
        // bytes actually produced by the decompressor.
        if (read > maxBytes) {
          stream.destroy();
          reject(unprocessable(`"${entryName(entry)}" expands beyond the allowed size`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', () => reject(unprocessable(`"${entryName(entry)}" is corrupt`)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(unprocessable(`The archive is corrupt: ${err.message}`));
    };
    const cleanup = () => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      zip.removeListener('error', onError);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}

export async function expandArchive(
  buffer: Buffer,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ArchiveExpansion> {
  const zip = await openZip(buffer);
  const members: ArchiveMember[] = [];
  const skipped: ArchiveSkip[] = [];
  let totalBytes = 0;
  let seen = 0;

  try {
    for (;;) {
      const entry = await nextEntry(zip);
      if (!entry) break;

      const raw = entryName(entry);
      if (raw.endsWith('/')) continue;

      seen += 1;
      if (seen > limits.maxEntries) {
        throw unprocessable(`The archive contains more than ${limits.maxEntries} files`);
      }

      const archivePath = safeArchivePath(raw);
      if (!archivePath) {
        skipped.push({ archivePath: raw, reason: 'Unsafe path inside the archive' });
        continue;
      }
      if (isSymlink(entry)) {
        skipped.push({ archivePath, reason: 'Symbolic links are not extracted' });
        continue;
      }

      const extension = posix.extname(archivePath).replace(/^\./, '').toLowerCase();
      if (ARCHIVE_EXTENSIONS.has(extension)) {
        skipped.push({ archivePath, reason: 'Nested archives are not extracted' });
        continue;
      }
      if (posix.basename(archivePath).startsWith('.') || archivePath.startsWith('__MACOSX/')) {
        skipped.push({ archivePath, reason: 'Metadata entry' });
        continue;
      }

      if (entry.uncompressedSize > limits.maxEntryBytes) {
        throw unprocessable(`"${archivePath}" is larger than the allowed extraction size`);
      }
      const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : 0;
      if (ratio > limits.maxCompressionRatio && entry.uncompressedSize > 1024 * 1024) {
        throw unprocessable(`"${archivePath}" has an implausible compression ratio`);
      }
      if (totalBytes + entry.uncompressedSize > limits.maxTotalBytes) {
        throw unprocessable('The archive expands beyond the allowed total size');
      }

      const content = await readEntry(zip, entry, limits.maxEntryBytes);
      if (content.length === 0) {
        skipped.push({ archivePath, reason: 'Empty file' });
        continue;
      }
      totalBytes += content.length;
      if (totalBytes > limits.maxTotalBytes) {
        throw unprocessable('The archive expands beyond the allowed total size');
      }

      members.push({
        archivePath,
        fileName: posix.basename(archivePath),
        sizeBytes: content.length,
        buffer: content,
      });
    }
  } finally {
    zip.close();
  }

  if (members.length === 0 && skipped.length === 0) {
    throw unprocessable('The archive contains no files');
  }

  return { members, skipped, totalBytes };
}
