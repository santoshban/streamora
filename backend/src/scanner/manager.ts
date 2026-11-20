import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { libraries, type Library, type MediaItem } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import type { LibraryScanner, ScanProgress, ScanSummary } from './scanner.js';
import { LibraryWatcher } from './watcher.js';

export interface ScanManagerOptions {
  db: DB;
  log: Logger;
  events: EventBus;
  scanner: LibraryScanner;
  scanOnStartup: boolean;
  /** Periodic full scans; 0 disables them. */
  intervalMinutes: number;
  watchPolling: boolean;
  /** Libraries scanned at the same time. */
  maxConcurrent?: number;
  /** Watcher debounce (tests shorten it). */
  watchDebounceMs?: number;
}

export interface LastScan extends Partial<ScanSummary> {
  kind: 'full' | 'partial';
  finishedAt: string;
  cancelled?: boolean;
  error?: string;
}

export interface ScanStatus {
  libraryId: number;
  state: 'idle' | 'queued' | 'running';
  kind: 'full' | 'partial' | null;
  refreshMetadata: boolean;
  progress: ScanProgress | null;
  startedAt: string | null;
  queued: { full: boolean; refreshMetadata: boolean; paths: number };
  watching: boolean;
  last: LastScan | null;
}

interface Running {
  kind: 'full' | 'partial';
  refreshMetadata: boolean;
  controller: AbortController;
  startedAt: Date;
  progress: ScanProgress | null;
  done: Promise<void>;
}

interface LibraryState {
  running?: Running;
  pendingFull?: { refreshMetadata: boolean };
  pendingPaths: Set<string>;
  last: LastScan | null;
  watcher?: LibraryWatcher;
  /** Paths the watcher was started with, to notice edits. */
  watchKey?: string;
}

const PROGRESS_EMIT_MS = 300;

/**
 * Queues and runs library scans: at most one per library at a time, a few
 * libraries in parallel, full scans on demand/startup/schedule and partial
 * scans fed by file watchers.
 */
export class ScanManager {
  private readonly states = new Map<number, LibraryState>();
  private readonly waiting: number[] = [];
  private active = 0;
  private interval?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private closed = false;

  constructor(private readonly opts: ScanManagerOptions) {}

  private state(libraryId: number): LibraryState {
    let s = this.states.get(libraryId);
    if (!s) {
      s = { pendingPaths: new Set(), last: null };
      this.states.set(libraryId, s);
    }
    return s;
  }

  private library(libraryId: number): Library | undefined {
    return this.opts.db.select().from(libraries).where(eq(libraries.id, libraryId)).get();
  }

  /** Starts watchers, the startup scan and the schedule. Call once plugins are loaded. */
  start(): void {
    const all = this.opts.db.select().from(libraries).all();
    for (const lib of all) {
      this.syncWatcher(lib);
      if (this.opts.scanOnStartup) this.requestScan(lib.id);
    }
    if (this.opts.intervalMinutes > 0) {
      this.interval = setInterval(() => {
        for (const lib of this.opts.db.select({ id: libraries.id }).from(libraries).all()) this.requestScan(lib.id);
      }, this.opts.intervalMinutes * 60_000);
      this.interval.unref();
    }
    this.unsubscribe = this.opts.events.subscribe((event) => {
      if (event.type !== 'library.changed') return;
      const { libraryId, action } = event.data as { libraryId: number; action: 'created' | 'updated' | 'deleted' };
      if (action === 'deleted') void this.forget(libraryId);
      else this.onLibraryEdited(libraryId, action === 'created');
    });
  }

  private onLibraryEdited(libraryId: number, created: boolean): void {
    const lib = this.library(libraryId);
    if (!lib) return;
    const pathsChanged = this.state(libraryId).watchKey !== JSON.stringify(lib.paths);
    this.syncWatcher(lib);
    if (created || pathsChanged) this.requestScan(libraryId);
  }

  private syncWatcher(lib: Library): void {
    const s = this.state(lib.id);
    const key = JSON.stringify(lib.paths);
    const wanted = lib.watch && !this.closed;
    if (s.watcher && (!wanted || s.watchKey !== key)) {
      void s.watcher.close();
      s.watcher = undefined;
    }
    s.watchKey = key;
    if (wanted && !s.watcher && lib.paths.length) {
      s.watcher = new LibraryWatcher({
        paths: lib.paths,
        usePolling: this.opts.watchPolling,
        log: this.opts.log.child({ library: lib.id, module: 'watcher' }),
        debounceMs: this.opts.watchDebounceMs,
        onChanges: (paths) => this.requestPartial(lib.id, paths),
      });
      s.watcher.start();
    }
  }

  private async forget(libraryId: number): Promise<void> {
    const s = this.states.get(libraryId);
    if (!s) return;
    s.pendingFull = undefined;
    s.pendingPaths.clear();
    s.running?.controller.abort(new Error('Library deleted'));
    await s.watcher?.close();
    await s.running?.done;
    this.states.delete(libraryId);
  }

  // ── requests ───────────────────────────────────────────────────────────────

  requestScan(libraryId: number, options: { refreshMetadata?: boolean } = {}): ScanStatus {
    const s = this.state(libraryId);
    const refreshMetadata = options.refreshMetadata === true;
    const running = s.running;
    const alreadyCovered = running?.kind === 'full' && (running.refreshMetadata || !refreshMetadata) && !s.pendingFull;
    if (!alreadyCovered) {
      s.pendingFull = { refreshMetadata: refreshMetadata || (s.pendingFull?.refreshMetadata ?? false) };
      this.enqueue(libraryId);
    }
    return this.status(libraryId);
  }

  requestPartial(libraryId: number, paths: string[]): void {
    if (this.closed || !paths.length) return;
    const s = this.state(libraryId);
    if (s.pendingFull) return; // the queued full scan will see these changes
    for (const p of paths) s.pendingPaths.add(p);
    this.enqueue(libraryId);
  }

  cancel(libraryId: number): boolean {
    const s = this.states.get(libraryId);
    if (!s) return false;
    const hadWork = !!(s.running || s.pendingFull || s.pendingPaths.size);
    s.pendingFull = undefined;
    s.pendingPaths.clear();
    const i = this.waiting.indexOf(libraryId);
    if (i >= 0) this.waiting.splice(i, 1);
    s.running?.controller.abort(new Error('Scan cancelled'));
    return hadWork;
  }

  status(libraryId: number): ScanStatus {
    const s = this.states.get(libraryId);
    const running = s?.running;
    const queued = !!(s?.pendingFull || s?.pendingPaths.size);
    return {
      libraryId,
      state: running ? 'running' : queued ? 'queued' : 'idle',
      kind: running?.kind ?? null,
      refreshMetadata: running?.refreshMetadata ?? false,
      progress: running?.progress ?? null,
      startedAt: running?.startedAt.toISOString() ?? null,
      queued: { full: !!s?.pendingFull, refreshMetadata: s?.pendingFull?.refreshMetadata ?? false, paths: s?.pendingPaths.size ?? 0 },
      watching: !!s?.watcher,
      last: s?.last ?? null,
    };
  }

  list(): ScanStatus[] {
    return this.opts.db
      .select({ id: libraries.id })
      .from(libraries)
      .all()
      .map((l) => this.status(l.id));
  }

  /** Resolves when the library has no running or queued scan (tests, CLI). */
  async idle(libraryId: number): Promise<void> {
    for (;;) {
      const s = this.states.get(libraryId);
      if (!s?.running && !s?.pendingFull && !s?.pendingPaths.size) return;
      if (s.running) await s.running.done;
      else await new Promise((r) => setTimeout(r, 20));
    }
  }

  refreshItem(itemId: number, options: { rematch?: boolean; externalIds?: Record<string, string>; lock?: boolean; signal?: AbortSignal }): Promise<MediaItem> {
    return this.opts.scanner.refreshItem(itemId, options);
  }

  // ── execution ──────────────────────────────────────────────────────────────

  private enqueue(libraryId: number): void {
    if (this.closed) return;
    const s = this.state(libraryId);
    if (!s.running && !this.waiting.includes(libraryId)) this.waiting.push(libraryId);
    this.pump();
  }

  private pump(): void {
    const max = this.opts.maxConcurrent ?? 2;
    while (this.active < max && this.waiting.length && !this.closed) {
      const libraryId = this.waiting.shift()!;
      const s = this.states.get(libraryId);
      if (!s || s.running) continue;
      const full = s.pendingFull;
      const paths = [...s.pendingPaths];
      if (!full && !paths.length) continue;
      s.pendingFull = undefined;
      s.pendingPaths.clear();
      this.active++;
      this.run(libraryId, s, full ? { kind: 'full', refreshMetadata: full.refreshMetadata } : { kind: 'partial', paths });
    }
  }

  private run(
    libraryId: number,
    s: LibraryState,
    request: { kind: 'full'; refreshMetadata: boolean } | { kind: 'partial'; paths: string[] },
  ): void {
    const controller = new AbortController();
    let lastEmit = 0;
    let lastPhase = '';
    const running: Running = {
      kind: request.kind,
      refreshMetadata: request.kind === 'full' && request.refreshMetadata,
      controller,
      startedAt: new Date(),
      progress: null,
      done: Promise.resolve(),
    };
    const onProgress = (p: ScanProgress) => {
      running.progress = p;
      const now = Date.now();
      if (p.phase === lastPhase && now - lastEmit < PROGRESS_EMIT_MS && p.processed < p.total) return;
      lastPhase = p.phase;
      lastEmit = now;
      this.opts.events.emit('scan.progress', { libraryId, ...p });
    };

    running.done = (async () => {
      const lib = this.library(libraryId);
      if (!lib) return;
      try {
        const summary = await this.opts.scanner.scan(
          lib,
          request.kind === 'full' ? { kind: 'full', refreshMetadata: request.refreshMetadata } : { kind: 'partial', paths: request.paths },
          controller.signal,
          onProgress,
        );
        s.last = { ...summary };
      } catch (err) {
        const cancelled = controller.signal.aborted;
        s.last = { kind: request.kind, finishedAt: new Date().toISOString(), cancelled, error: cancelled ? undefined : errorMessage(err) };
        if (cancelled) this.opts.log.info({ library: libraryId }, 'Scan cancelled');
        else this.opts.log.error({ library: libraryId, err }, 'Scan failed');
        this.opts.events.emit('scan.completed', { libraryId, added: 0, updated: 0, removed: 0 });
      }
    })().finally(() => {
      s.running = undefined;
      this.active--;
      if (s.pendingFull || s.pendingPaths.size) this.enqueue(libraryId);
      this.pump();
    });
    s.running = running;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval);
    this.unsubscribe?.();
    this.waiting.length = 0;
    const pending: Promise<void>[] = [];
    for (const s of this.states.values()) {
      s.pendingFull = undefined;
      s.pendingPaths.clear();
      s.running?.controller.abort(new Error('Server shutting down'));
      if (s.running) pending.push(s.running.done);
      if (s.watcher) pending.push(s.watcher.close());
    }
    await Promise.allSettled(pending);
  }
}
