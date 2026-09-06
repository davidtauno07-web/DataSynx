import { Worker } from 'bullmq';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { ensureBucket } from '../lib/storage.js';
import { EXPORT_QUEUE, PROCESSING_QUEUE, type ExportJobData, type ProcessItemJob } from '../queue/queues.js';
import { runExport } from '../modules/exports/service.js';
import { processItem } from './processItem.js';

const PROCESSING_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);

async function main(): Promise<void> {
  await ensureBucket();

  const processingWorker = new Worker<ProcessItemJob>(
    PROCESSING_QUEUE,
    async (job) => processItem(job.data),
    { connection: createRedis(), concurrency: PROCESSING_CONCURRENCY },
  );

  const exportWorker = new Worker<ExportJobData>(
    EXPORT_QUEUE,
    async (job) => runExport(job.data.exportJobId),
    { connection: createRedis(), concurrency: 2 },
  );

  for (const [name, worker] of [
    ['processing', processingWorker],
    ['export', exportWorker],
  ] as const) {
    worker.on('failed', (job, err) => logger.error({ queue: name, jobId: job?.id, err }, 'worker job failed'));
    worker.on('error', (err) => logger.error({ queue: name, err }, 'worker error'));
  }

  logger.info({ concurrency: PROCESSING_CONCURRENCY }, 'DataSynx worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await Promise.all([processingWorker.close(), exportWorker.close()]);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
