import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

/** Server-sent events (`GET /api/events`), one connection shared by the whole app. */

export type ServerEventType =
  | 'plugins.changed'
  | 'plugin.status'
  | 'library.changed'
  | 'scan.progress'
  | 'scan.completed'
  | 'metadata.updated'
  | 'transcode.ready';

type Handler = (type: ServerEventType, data: Record<string, unknown>) => void;

const TYPES: ServerEventType[] = [
  'plugins.changed',
  'plugin.status',
  'library.changed',
  'scan.progress',
  'scan.completed',
  'metadata.updated',
  'transcode.ready',
];

const EventsContext = createContext<Set<Handler> | null>(null);

export function ServerEventsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const handlers = useRef(new Set<Handler>()).current;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    const listeners = TYPES.map((type) => {
      const listener = (e: MessageEvent<string>) => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(e.data) as Record<string, unknown>;
        } catch {
          return;
        }
        for (const h of handlers) h(type, data);
      };
      source.addEventListener(type, listener as EventListener);
      return [type, listener] as const;
    });
    return () => {
      for (const [type, l] of listeners) source.removeEventListener(type, l as EventListener);
      source.close();
    };
  }, [enabled, handlers]);

  return <EventsContext.Provider value={handlers}>{children}</EventsContext.Provider>;
}

/** Calls `handler` for every server event of the given types (latest handler wins, no resubscribe churn). */
export function useServerEvents(types: ServerEventType[], handler: (type: ServerEventType, data: Record<string, unknown>) => void) {
  const handlers = useContext(EventsContext);
  const latest = useRef(handler);
  latest.current = handler;
  const key = types.join(',');
  useEffect(() => {
    if (!handlers) return;
    const wanted = new Set(key.split(','));
    const h: Handler = (type, data) => {
      if (wanted.has(type)) latest.current(type, data);
    };
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }, [handlers, key]);
}
