import type { FileObject, Modality } from '@prisma/client';
import type { ProcessingOutput } from '../domain/results.js';

export interface ProcessorContext {
  file: FileObject;
  /** Short-lived presigned URL to the *original*, never-mutated object. */
  fileUrl: string;
  options: Record<string, unknown>;
  onStage: (stage: string, progress: number) => Promise<void>;
}

/**
 * Every modality implements this single interface, which is what keeps the
 * pipelines independent and the underlying models replaceable.
 */
export interface Processor {
  readonly modality: Modality;
  readonly name: string;
  process(ctx: ProcessorContext): Promise<ProcessingOutput>;
}
