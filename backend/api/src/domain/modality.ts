import { Modality } from '@prisma/client';

export interface FileSignature {
  originalName: string;
  extension: string;
  declaredMime: string;
  detectedMime?: string;
  sizeBytes: number;
  /** Optional hint supplied by the import surface (e.g. voice recorder). */
  hint?: 'voice' | 'email' | 'cctv' | 'drone';
}

const DOCUMENT_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/rtf',
]);

const EMAIL_MIME = new Set(['message/rfc822', 'application/vnd.ms-outlook']);

const INVOICE_HINTS = /(invoice|faktura|rechnung|facture|bill|receipt|arve)/i;
const DRONE_HINTS = /(drone|dji|uav|aerial|mavic|phantom|orthophoto)/i;
const CCTV_HINTS = /(cctv|surveillance|camera|cam[-_ ]?\d|nvr|dvr|security)/i;

export const ACCEPTED_EXTENSIONS = [
  'zip',
  'pdf', 'doc', 'docx', 'txt', 'csv', 'xls', 'xlsx', 'rtf', 'eml', 'msg',
  'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'heic',
  'wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'webm',
  'mp4', 'mov', 'avi', 'mkv', 'mpg', 'mpeg', 'ts',
] as const;

const VIDEO_EXT = new Set(['mp4', 'mov', 'avi', 'mkv', 'mpg', 'mpeg', 'ts']);
const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'heic']);

/**
 * Deterministic content router. Runs on signature + declared metadata only —
 * it decides which specialised pipeline receives the file, and each pipeline
 * remains fully independent of the others.
 */
export function routeModality(sig: FileSignature): Modality {
  const ext = sig.extension.toLowerCase().replace(/^\./, '');
  const mime = (sig.detectedMime || sig.declaredMime || '').toLowerCase();
  const name = sig.originalName;

  if (sig.hint === 'voice') return Modality.AUDIO;
  if (sig.hint === 'email') return Modality.EMAIL;
  if (sig.hint === 'cctv') return Modality.CCTV;
  if (sig.hint === 'drone') return Modality.DRONE;

  // A container is never a processing item; its members are ingested separately.
  if (ext === 'zip') return Modality.ARCHIVE;

  if (EMAIL_MIME.has(mime) || ext === 'eml' || ext === 'msg') return Modality.EMAIL;

  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) {
    if (DRONE_HINTS.test(name)) return Modality.DRONE;
    // Video defaults to the CCTV pipeline; drone footage is either named or
    // explicitly routed by the user at import time.
    return Modality.CCTV;
  }

  if (mime.startsWith('audio/') || AUDIO_EXT.has(ext)) return Modality.AUDIO;

  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) {
    if (DRONE_HINTS.test(name)) return Modality.DRONE;
    if (INVOICE_HINTS.test(name)) return Modality.INVOICE;
    if (CCTV_HINTS.test(name)) return Modality.CCTV;
    return Modality.IMAGE;
  }

  if (DOCUMENT_MIME.has(mime) || ['pdf', 'doc', 'docx', 'txt', 'csv', 'xls', 'xlsx', 'rtf'].includes(ext)) {
    if (INVOICE_HINTS.test(name)) return Modality.INVOICE;
    return Modality.DOCUMENT;
  }

  return Modality.UNKNOWN;
}

export const modalityLabel: Record<Modality, string> = {
  DOCUMENT: 'Document',
  INVOICE: 'Invoice',
  EMAIL: 'Email',
  AUDIO: 'Audio',
  IMAGE: 'Image',
  CCTV: 'CCTV',
  DRONE: 'Drone',
  ARCHIVE: 'Archive',
  UNKNOWN: 'Unrecognised',
};
