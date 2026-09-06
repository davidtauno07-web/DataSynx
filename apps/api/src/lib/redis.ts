import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

const globalForRedis = globalThis as unknown as { redis?: Redis };
export const redis = globalForRedis.redis ?? createRedis();
if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;
