import { z } from 'zod';

/**
 * Measurements are produced exclusively by deterministic maths in the
 * measurement engine. `status` is mandatory so the UI can never present an
 * unavailable value as if it were measured.
 */
export const measurementStatusSchema = z.enum(['MEASURED', 'ESTIMATED', 'UNAVAILABLE']);

export const measurementSchema = z.object({
  subject: z.string(),
  parameter: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  status: measurementStatusSchema,
  method: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  quality: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  reason: z.string().nullable().default(null),
});

export type Measurement = z.infer<typeof measurementSchema>;

export const compilationRowSchema = z.object({
  rowKey: z.string(),
  data: z.record(z.unknown()),
  geometry: z.unknown().nullable().default(null),
});

/**
 * A contextual clip window an engine derived from detected events. The API
 * cuts the media; the engine only says which window carries which evidence.
 */
export const clipSpecSchema = z.object({
  clipKey: z.string(),
  subject: z.string(),
  objectType: z.string(),
  sequence: z.number().int().min(1),
  startTime: z.number().min(0),
  endTime: z.number().min(0),
  eventTime: z.number().min(0),
  durationSeconds: z.number().min(0),
  kinds: z.array(z.string()).default([]),
  events: z.array(z.record(z.unknown())).default([]),
  reason: z.string().default(''),
});

export const processingOutputSchema = z.object({
  engine: z.string(),
  engineVersion: z.string(),
  demo: z.boolean().default(false),
  /** Human-oriented structured payload rendered by the Processing page. */
  summary: z.record(z.unknown()),
  measurements: z.array(measurementSchema).default([]),
  warnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  clips: z.array(clipSpecSchema).default([]),
  compilation: z.object({
    columns: z.array(z.string()),
    rows: z.array(compilationRowSchema),
  }),
});

export type ProcessingOutput = z.infer<typeof processingOutputSchema>;
export type CompilationRow = z.infer<typeof compilationRowSchema>;
export type ClipSpec = z.infer<typeof clipSpecSchema>;
