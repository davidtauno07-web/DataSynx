import { Queue, type JobsOptions } from 'bullmq';
import { createRedis } from '../lib/redis.js';

export const PROCESSING_QUEUE = 'datasynx.processing';
export const EXPORT_QUEUE = 'datasynx.export';

export interface ProcessItemJob {
  itemId: string;
  jobId: string;
  workspaceId: string;
}

export interface ExportJobData {
  exportJobId: string;
  workspaceId: string;
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 604_800 },
};

let processingQueue: Queue<ProcessItemJob> | null = null;
let exportQueue: Queue<ExportJobData> | null = null;

export function getProcessingQueue(): Queue<ProcessItemJob> {
  processingQueue ??= new Queue<ProcessItemJob>(PROCESSING_QUEUE, {
    connection: createRedis(),
    defaultJobOptions,
  });
  return processingQueue;
}

export function getExportQueue(): Queue<ExportJobData> {
  exportQueue ??= new Queue<ExportJobData>(EXPORT_QUEUE, {
    connection: createRedis(),
    defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
  });
  return exportQueue;
}

export async function closeQueues(): Promise<void> {
  await processingQueue?.close();
  await exportQueue?.close();
  processingQueue = null;
  exportQueue = null;
}
