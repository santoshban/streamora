import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Logger } from '../lib/logger.js';
import { isPathInside } from '../lib/paths.js';
import {
  isAudioFile,
  isLyricsFile,
  isSidecarMetadataFile,
  isSkippedDir,
  isSkippedMusicDir,
  isSubtitleFile,
  isVideoFile,
} from '../media/extensions.js';

export interface WatcherOptions {
  paths: string[];
  /** Poll instead of native events (network shares, Docker bind mounts on some hosts). */
  usePolling: boolean;
  log: Logger;
  /** Receives batched, de-duplicated paths once the folder has been quiet for `debounceMs`. */
  onChanges: (paths: string[]) => void;
  debounceMs?: number;
  /** Flush even if events keep arriving (e.g. a long copy of a season). */
  maxWaitMs?: number;
  /** Music library: audio and .lrc files matter, and only system folders are skipped. */
  music?: boolean;
}

const isRelevantVideoFile = (p: string) => isVideoFile(p) || isSubtitleFile(p) || isSidecarMetadataFile(p);
const isRelevantMusicFile = (p: string) => isAudioFile(p) || isLyricsFile(p) || isSidecarMetadataFile(p);

/** Watches a library's folders and reports changed paths in batches. */
export class LibraryWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private firstEventAt = 0;

  constructor(private readonly opts: WatcherOptions) {}

  start(): void {
    const { paths, usePolling, log } = this.opts;
    const roots = paths.map((p) => path.resolve(p));
    const isRelevantFile = this.opts.music ? isRelevantMusicFile : isRelevantVideoFile;
    const skipDir = this.opts.music ? isSkippedMusicDir : isSkippedDir;

    const ignored = (p: string, stats?: { isFile(): boolean }) => {
      const root = roots.find((r) => isPathInside(p, r));
      if (!root) return false;
      const rel = path.relative(root, p);
      if (rel && rel.split(/[\\/]/).some((part, i, all) => (i < all.length - 1 || !stats?.isFile()) && skipDir(part))) {
        return true;
      }
      return !!stats?.isFile() && !isRelevantFile(p);
    };

    this.watcher = watch(roots, {
      ignoreInitial: true,
      persistent: true,
      depth: 20,
      usePolling,
      interval: usePolling ? 30_000 : 100,
      binaryInterval: usePolling ? 60_000 : 300,
      // Big copies: report a file once its size has stopped changing.
      awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 1000 },
      ignored,
    });

    const onFile = (p: string) => {
      if (isRelevantFile(p)) this.push(p);
    };
    this.watcher
      .on('add', onFile)
      .on('change', onFile)
      .on('unlink', onFile)
      .on('addDir', (p) => this.push(p))
      .on('unlinkDir', (p) => this.push(p))
      .on('error', (err) => log.debug({ err }, 'File watcher error'));
  }

  private push(p: string): void {
    this.pending.add(p);
    const now = Date.now();
    if (!this.firstEventAt) this.firstEventAt = now;
    clearTimeout(this.timer);
    const debounce = this.opts.debounceMs ?? 2000;
    const maxWait = this.opts.maxWaitMs ?? 20_000;
    const delay = Math.max(0, Math.min(debounce, this.firstEventAt + maxWait - now));
    this.timer = setTimeout(() => this.flush(), delay);
  }

  private flush(): void {
    this.timer = undefined;
    this.firstEventAt = 0;
    if (!this.pending.size) return;
    // Drop paths already covered by a changed parent folder.
    const all = [...this.pending].sort((a, b) => a.length - b.length);
    this.pending.clear();
    const batch: string[] = [];
    for (const p of all) if (!batch.some((parent) => isPathInside(p, parent))) batch.push(p);
    this.opts.onChanges(batch);
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
