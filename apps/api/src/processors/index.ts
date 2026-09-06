import { Modality } from '@prisma/client';
import { aiClient } from '../services/ai/client.js';
import { unprocessable } from '../lib/errors.js';
import type { Processor, ProcessorContext } from './types.js';

/**
 * Each modality maps to one remote engine in the Python AI service. The
 * indirection is deliberate: swapping a model, or an entire provider, only
 * changes the service behind this boundary.
 */
function remoteProcessor(modality: Modality, engine: string, stages: string[]): Processor {
  return {
    modality,
    name: engine,
    async process(ctx: ProcessorContext) {
      for (const [index, stage] of stages.entries()) {
        await ctx.onStage(stage, Math.round(((index + 1) / (stages.length + 1)) * 90));
      }
      return aiClient.process(engine, {
        fileUrl: ctx.fileUrl,
        fileReference: ctx.file.reference,
        originalName: ctx.file.originalName,
        mimeType: ctx.file.detectedMime ?? ctx.file.mimeType,
        sizeBytes: Number(ctx.file.sizeBytes),
        options: ctx.options,
        payload: (ctx.file.metadata as Record<string, unknown> | null) ?? undefined,
      });
    },
  };
}

const registry = new Map<Modality, Processor>([
  [Modality.DOCUMENT, remoteProcessor(Modality.DOCUMENT, 'document', ['Preprocessing', 'Text extraction', 'Structuring'])],
  [Modality.INVOICE, remoteProcessor(Modality.INVOICE, 'invoice', ['Preprocessing', 'OCR', 'Field extraction', 'Validation'])],
  [Modality.EMAIL, remoteProcessor(Modality.EMAIL, 'email', ['Parsing', 'Entity extraction', 'Structuring'])],
  [Modality.AUDIO, remoteProcessor(Modality.AUDIO, 'audio', ['Normalisation', 'Noise reduction', 'Voice activity detection', 'Transcription'])],
  [Modality.IMAGE, remoteProcessor(Modality.IMAGE, 'image', ['Preprocessing', 'Detection', 'Structuring'])],
  [Modality.CCTV, remoteProcessor(Modality.CCTV, 'cctv', ['Validation', 'Frame extraction', 'Detection', 'Tracking', 'Measurement'])],
  [Modality.DRONE, remoteProcessor(Modality.DRONE, 'drone', ['Metadata extraction', 'Detection', 'Geospatial processing', 'Measurement'])],
]);

export function getProcessor(modality: Modality): Processor {
  const processor = registry.get(modality);
  if (!processor) {
    throw unprocessable(
      'This file type is not supported by any DataSynx pipeline',
      { modality },
    );
  }
  return processor;
}

export const supportedModalities = [...registry.keys()];
