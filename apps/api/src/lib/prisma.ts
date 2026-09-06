import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

function createClient() {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
  client.$on('warn', (e) => logger.warn({ prisma: e.message }));
  client.$on('error', (e) => logger.error({ prisma: e.message }));
  return client;
}

type Client = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as { prisma?: Client };

export const prisma: Client = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** BigInt is not JSON-serialisable; normalise DB payloads before responding. */
export function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as T;
}
