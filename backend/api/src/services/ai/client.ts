import { request } from 'undici';
import { env } from '../../config/env.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { processingOutputSchema, type ProcessingOutput } from '../../domain/results.js';

export interface AiCapabilities {
  mode: 'real' | 'demo';
  device: string;
  engines: Record<string, { available: boolean; detail: string }>;
}

async function call<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
  const started = Date.now();
  let res;
  try {
    res = await request(`${env.AI_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.AI_SERVICE_TOKEN}`,
      },
      body: JSON.stringify(body),
      headersTimeout: env.AI_REQUEST_TIMEOUT_MS,
      bodyTimeout: env.AI_REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    logger.error({ err, path }, 'AI service unreachable');
    throw serviceUnavailable('AI processing unavailable', {
      reason: 'The DataSynx AI service could not be reached',
      path,
    });
  }

  const text = await res.body.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = { detail: text.slice(0, 500) || `AI service returned ${res.statusCode}` };
  }
  logger.info({ path, status: res.statusCode, ms: Date.now() - started }, 'ai call');

  if (res.statusCode >= 400) {
    const detail =
      typeof payload === 'object' && payload && 'detail' in payload
        ? String((payload as { detail: unknown }).detail)
        : `AI service returned ${res.statusCode}`;
    throw serviceUnavailable('AI processing failed', { reason: detail, path });
  }

  return parse(payload);
}

export interface ProcessRequest {
  fileUrl: string;
  fileReference: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  options?: Record<string, unknown>;
  /** Inline payload for modalities that do not have a binary (e.g. email). */
  payload?: Record<string, unknown>;
}

export const aiClient = {
  async capabilities(): Promise<AiCapabilities> {
    try {
      const res = await request(`${env.AI_SERVICE_URL}/v1/capabilities`, {
        method: 'GET',
        headers: { authorization: `Bearer ${env.AI_SERVICE_TOKEN}` },
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      return (await res.body.json()) as AiCapabilities;
    } catch {
      return { mode: env.DATASYNX_MODE, device: 'unknown', engines: {} };
    }
  },

  process(engine: string, req: ProcessRequest): Promise<ProcessingOutput> {
    return call(`/v1/process/${engine}`, { ...req, mode: env.DATASYNX_MODE }, (raw) =>
      processingOutputSchema.parse(raw),
    );
  },

  /** Deterministic geometry/measurement helpers used by the command assistant. */
  measure<T>(operation: string, params: Record<string, unknown>, parse: (raw: unknown) => T): Promise<T> {
    return call('/v1/measure', { operation, params }, parse);
  },
};
