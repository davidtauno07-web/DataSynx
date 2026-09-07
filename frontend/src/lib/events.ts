import { useEffect } from 'react';

export type ProcessingEventType =
  | 'job.updated'
  | 'item.updated'
  | 'item.completed'
  | 'compilation.updated'
  | 'export.updated';

export interface ProcessingEvent {
  type: ProcessingEventType;
  workspaceId: string;
  jobId?: string;
  itemId?: string;
  payload: Record<string, unknown>;
}

/**
 * Subscribes to the API server-sent event stream. The browser reconnects
 * automatically; `enabled` lets pages drop the stream when signed out.
 */
export function useProcessingEvents(handler: (event: ProcessingEvent) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/processing/stream', { withCredentials: true });
    const types: ProcessingEventType[] = [
      'job.updated',
      'item.updated',
      'item.completed',
      'compilation.updated',
      'export.updated',
    ];
    const listeners = types.map((type) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          handler(JSON.parse(event.data) as ProcessingEvent);
        } catch {
          // A malformed frame must not break the stream.
        }
      };
      source.addEventListener(type, listener as EventListener);
      return [type, listener] as const;
    });

    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener as EventListener);
      source.close();
    };
  }, [handler, enabled]);
}
