import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { ensureBucket } from './lib/storage.js';
import { closeQueues } from './queue/queues.js';
import { closeEventBus } from './events/bus.js';

async function main(): Promise<void> {
  await ensureBucket();

  const app = createApp();
  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT, mode: env.DATASYNX_MODE }, 'DataSynx API listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await closeQueues();
    await closeEventBus();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start API');
  process.exit(1);
});
