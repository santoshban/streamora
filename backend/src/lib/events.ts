import { EventEmitter } from 'node:events';

/**
 * Server → browser events, delivered over SSE (`GET /api/events`).
 * Add new event types here; the payload type flows through to emitters and
 * the SSE route automatically.
 */
export interface ServerEvents {
  'plugins.changed': { reason: 'discovered' | 'removed' | 'reloaded' | 'updated' };
  'plugin.status': { id: string; status: string; error?: string };
  'library.changed': { libraryId: number; action: 'created' | 'updated' | 'deleted' };
  'scan.progress': { libraryId: number; phase: string; processed: number; total: number; current?: string };
  'scan.completed': { libraryId: number; added: number; updated: number; removed: number };
  'metadata.updated': { mediaItemId: number };
  'transcode.ready': { sessionId: string };
}

export type ServerEventName = keyof ServerEvents;

export interface ServerEventEnvelope<K extends ServerEventName = ServerEventName> {
  id: number;
  type: K;
  data: ServerEvents[K];
  at: string;
}

type Listener = (event: ServerEventEnvelope) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private seq = 0;

  constructor() {
    // One listener per connected browser tab.
    this.emitter.setMaxListeners(0);
  }

  emit<K extends ServerEventName>(type: K, data: ServerEvents[K]): void {
    const envelope: ServerEventEnvelope<K> = { id: ++this.seq, type, data, at: new Date().toISOString() };
    this.emitter.emit('event', envelope);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}
