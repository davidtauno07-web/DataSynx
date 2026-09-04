import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export const BUCKET = env.S3_BUCKET;

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    logger.info({ bucket: BUCKET }, 'created object storage bucket');
  }
}

export async function putObject(
  key: string,
  body: Buffer | Readable,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // MinIO/S3 server-side encryption at rest where the backend supports it.
      ServerSideEncryption: env.NODE_ENV === 'production' ? 'AES256' : undefined,
    }),
  );
}

export async function getObjectStream(key: string): Promise<Readable> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body as Readable;
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const stream = await getObjectStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function presignGet(key: string, expiresInSeconds = 900): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}

/**
 * Storage keys are always server-generated from opaque ids — user-supplied
 * filenames never reach the key, which removes path-traversal risk.
 */
export function buildStorageKey(parts: {
  workspaceId: string;
  kind: 'original' | 'derived' | 'export';
  id: string;
  extension: string;
}): string {
  const ext = parts.extension.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${parts.workspaceId}/${parts.kind}/${parts.id}${ext ? `.${ext}` : ''}`;
}
