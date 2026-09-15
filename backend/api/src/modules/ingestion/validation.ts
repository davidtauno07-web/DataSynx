import { extname } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { badRequest, unprocessable } from '../../lib/errors.js';
import { ACCEPTED_EXTENSIONS } from '../../domain/modality.js';

export interface ValidatedFile {
  originalName: string;
  extension: string;
  declaredMime: string;
  detectedMime: string | null;
  sizeBytes: number;
}

const TEXT_LIKE = new Set(['txt', 'csv', 'eml', 'json', 'md']);

/** Filenames are never trusted for storage; they are only kept as metadata. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be stripped
  const control = /[\u0000-\u001f<>:"|?*]/g;
  return base.replace(control, '_').slice(0, 255) || 'file';
}

export async function validateUpload(
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
): Promise<ValidatedFile> {
  const originalName = sanitizeFilename(file.originalname);
  const extension = extname(originalName).replace(/^\./, '').toLowerCase();

  if (!extension) throw badRequest(`"${originalName}" has no file extension`);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw unprocessable(`File type ".${extension}" is not supported`, { originalName });
  }
  if (file.size <= 0) throw badRequest(`"${originalName}" is empty`);

  // Magic-byte inspection: the declared MIME type alone is attacker-controlled.
  const sniffed = await fileTypeFromBuffer(file.buffer);
  const detectedMime = sniffed?.mime ?? null;

  if (!sniffed && !TEXT_LIKE.has(extension)) {
    throw unprocessable(`"${originalName}" does not have a recognisable file signature`, {
      originalName,
    });
  }

  if (sniffed && !isSignatureCompatible(extension, sniffed.ext)) {
    throw unprocessable(
      `"${originalName}" content (${sniffed.ext}) does not match its .${extension} extension`,
      { originalName, detected: sniffed.ext },
    );
  }

  return {
    originalName,
    extension,
    declaredMime: file.mimetype || sniffed?.mime || 'application/octet-stream',
    detectedMime,
    sizeBytes: file.size,
  };
}

/** Container formats legitimately share signatures; allow known equivalences. */
function isSignatureCompatible(extension: string, detected: string): boolean {
  if (extension === detected) return true;
  const groups: string[][] = [
    ['jpg', 'jpeg'],
    ['tif', 'tiff'],
    ['mp4', 'mov', 'm4a', 'm4v', 'mp4a'],
    ['docx', 'zip', 'cfb', 'doc'],
    ['xlsx', 'zip', 'cfb', 'xls'],
    ['ogg', 'oga', 'opus'],
    ['webm', 'mkv'],
    ['mpg', 'mpeg', 'ts'],
    ['msg', 'cfb'],
  ];
  return groups.some((g) => g.includes(extension) && g.includes(detected));
}
