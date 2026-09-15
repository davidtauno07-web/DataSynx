import { EventEmitter } from 'node:events';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export type ProcessingEvent =
  | { type: 'job.updated'; workspaceId: string; jobId: string; payload: Record<string, unknown> }
  | { type: 'item.updated'; workspaceId: string; jobId: string; itemId: string; payload: Record<string, unknown> }
  | { type: 'item.completed'; workspaceId: string; jobId: string; itemId: string; payload: Record<string, unknown> }
  | { type: 'compilation.updated'; workspaceId: string; payload: Record<string, unknown> }
  | { type: 'export.updated'; workspaceId: string; payload: Record<string, unknown> };

const CHANNEL = 'datasynx:events';

const publisher = createRedis();
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let subscriber: ReturnType<typeof createRedis> | null = null;

/** Redis fan-out keeps SSE working across multiple API instances. */
function ensureSubscriber(): void {
  if (subscriber) return;
  subscriber = createRedis();
  subscriber.subscribe(CHANNEL).catch((err) => logger.error({ err }, 'event subscribe failed'));
  subscriber.on('message', (_channel, message) => {
    try {
      emitter.emit('event', JSON.parse(message) as ProcessingEvent);
    } catch (err) {
      logger.warn({ err }, 'malformed event payload');
    }
  });
}

export async function publishEvent(event: ProcessingEvent): Promise<void> {
  try {
    await publisher.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, type: event.type }, 'failed to publish event');
  }
}

export function subscribeEvents(
  workspaceId: string,
  handler: (event: ProcessingEvent) => void,
): () => void {
  ensureSubscriber();
  const listener = (event: ProcessingEvent) => {
    if (event.workspaceId === workspaceId) handler(event);
  };
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

export async function closeEventBus(): Promise<void> {
  await publisher.quit().catch(() => undefined);
  if (subscriber) await subscriber.quit().catch(() => undefined);
}
