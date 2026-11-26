import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MediaFileInfo, ScanCompletedEvent, ScannedItemRef } from '@streamora/plugin-sdk';
import type { DB } from '../db/client.js';
import {
  episodes,
  libraries,
  mediaFiles,
  mediaItems,
  plugins as pluginsTable,
  seasons,
  subtitleTracks,
  type Library,
  type MediaFile,
  type MediaItem,
  type ParsedFileName,
} from '../db/schema.js';
import { chunk, mapLimit, yieldToEventLoop } from '../lib/async.js';
import { errorMessage } from '../lib/errors.js';
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { isPathInside } from '../lib/paths.js';
import { isInSkippedDir, isSidecarMetadataFile, isSubtitleFile, isVideoFile } from '../media/extensions.js';
import { MusicScanner } from '../music/scanner.js';
import { sortTitleOf } from '../media/parse.js';
import type { MediaProbe } from '../media/probe.js';
import type { MetadataService } from '../plugins/services/metadata.js';
import type { PostScanService } from '../plugins/services/post-scan.js';
import type { SubtitleService } from '../plugins/services/subtitles.js';
import { identifyFile, type FileIdentity } from './identify.js';
import { refreshItemMetadata, refreshSeasons, type MetadataDeps } from './metadata.js';
import { pathKey, walkRoots, walkTargets, type WalkedFile } from './walk.js';

export type ScanPhase = 'discovering' | 'probing' | 'saving' | 'cleanup' | 'metadata' | 'subtitles';

export interface ScanProgress {
  phase: ScanPhase;
  processed: number;
  total: number;
  current?: string;
}

export interface ScanRequest {
  kind: 'full' | 'partial';
  /** `partial`: paths reported by the file watcher (files or folders, existing or deleted). */
  paths?: string[];
  /** Re-run metadata agents for every item, not only new ones. */
  refreshMetadata?: boolean;
}

export interface ScanSummary {
  kind: 'full' | 'partial';
  startedAt: string;
  finishedAt: string;
  /** Movies/shows. */
  added: number;
  updated: number;
  removed: number;
  files: { added: number; updated: number; removed: number; missing: number; unchanged: number };
  /** Video files whose name could not be understood (first 50). */
  unidentified: string[];
  errors: string[];
}

/** Thrown by the probe function when ffprobe is not installed (files are re-probed later). */
export class ProbeUnavailableError extends Error {
  constructor() {
    super('ffprobe is not available');
    this.name = 'ProbeUnavailableError';
  }
}

export interface ScannerDeps {
  db: DB;
  log: Logger;
  events: EventBus;
  metadata: MetadataService;
  subtitles: SubtitleService;
  postScan: PostScanService;
  probe: (file: string, signal: AbortSignal) => Promise<MediaProbe>;
  /** False while ffprobe is missing: files that could not be probed are not re-saved on every scan. */
  probeAvailable: () => boolean;
  probeConcurrency: number;
  /** Called before media file rows are deleted (stops their streaming sessions). */
  onFilesRemoved?: (fileIds: number[]) => Promise<void>;
}

const UNMATCHED_RETRY_MS = 24 * 60 * 60_000;
const MAX_LISTED = 50;
const SUBTITLE_CONCURRENCY = 4;

type ProbeOutcome = { probe: MediaProbe } | { error: string; unavailable: boolean };

interface Pending {
  walked: WalkedFile;
  root: string;
  existing?: MediaFile;
}

/** Mutable bookkeeping for one scan. */
class ScanState {
  createdItems = new Set<number>();
  updatedItems = new Set<number>();
  /** show id → season numbers that gained episodes. */
  newSeasons = new Map<number, Set<number>>();
  savedFiles = new Set<number>();
  removedItems: Array<{ id: number; kind: MediaItem['kind']; title: string }> = [];
  subtitleDirs = new Set<string>();
  metadataDirs = new Set<string>();
  unidentified: string[] = [];
  errors: string[] = [];
  files = { added: 0, updated: 0, removed: 0, missing: 0, unchanged: 0 };

  error(message: string): void {
    if (this.errors.length < MAX_LISTED) this.errors.push(message);
  }
}

function toFileInfo(f: MediaFile): MediaFileInfo {
  return {
    path: f.path,
    container: f.container ?? undefined,
    sizeBytes: f.sizeBytes,
    durationSeconds: f.durationSeconds ?? undefined,
    streams: f.streams,
  };
}

/** Last line of an ffprobe error, without the file path ffprobe repeats in it. */
function probeErrorSummary(file: string, error: string): string {
  const last = error.trim().split(/\r?\n/).at(-1)?.trim() ?? error;
  return last.startsWith(file) ? last.slice(file.length).replace(/^:\s*/, '') : last;
}

/** Folders whose subtitle files belong to videos one level up (`Movie/Subs/x.srt`). */
const SIDECAR_SUBFOLDER = /^(?:subs?|subtitles?)$/i;

export class LibraryScanner {
  private readonly music: MusicScanner;

  constructor(private readonly deps: ScannerDeps) {
    this.music = new MusicScanner({
      db: deps.db,
      log: deps.log,
      events: deps.events,
      probe: deps.probe,
      probeAvailable: deps.probeAvailable,
      probeConcurrency: deps.probeConcurrency,
      isProbeUnavailable: (err) => err instanceof ProbeUnavailableError,
    });
  }

  private get db(): DB {
    return this.deps.db;
  }

  private get metadataDeps(): MetadataDeps {
    return { db: this.deps.db, metadata: this.deps.metadata, events: this.deps.events, log: this.deps.log };
  }

  async scan(
    library: Library,
    request: ScanRequest,
    signal: AbortSignal,
    onProgress: (p: ScanProgress) => void = () => undefined,
  ): Promise<ScanSummary> {
    if (library.type === 'music') return this.music.scan(library, request, signal, onProgress);
    const startedAt = new Date();
    const state = new ScanState();
    const full = request.kind === 'full';
    const roots = library.paths;
    const rootOf = (p: string) => roots.find((r) => isPathInside(p, r));
    const log = this.deps.log.child({ library: library.id, scan: request.kind });

    // ── 1. discover ──────────────────────────────────────────────────────────
    onProgress({ phase: 'discovering', processed: 0, total: 0 });
    let walkedFiles: WalkedFile[];
    let dirMtimes: Map<string, number>;
    let gone: string[] = [];
    const unsafeRoots = new Set<string>();

    const existing = this.db.select().from(mediaFiles).where(eq(mediaFiles.libraryId, library.id)).all();
    const byKey = new Map(existing.map((f) => [pathKey(f.path), f]));

    if (full) {
      const walk = await walkRoots(roots, signal);
      walkedFiles = walk.files;
      dirMtimes = walk.dirs;
      walk.errors.forEach((e) => state.error(e));
      for (const r of walk.unreadableRoots) {
        unsafeRoots.add(pathKey(r));
        state.error(`Library folder is not readable: ${r}`);
      }
      for (const r of walk.emptyRoots) {
        // An empty root that used to hold files is usually an unmounted drive: don't wipe the library.
        if (existing.some((f) => isPathInside(f.path, r))) {
          unsafeRoots.add(pathKey(r));
          state.error(`Library folder is empty, keeping its items until it is back: ${r}`);
        }
      }
    } else {
      const targets = (request.paths ?? []).filter((p) => {
        const root = rootOf(p);
        return !!root && !isInSkippedDir(p, root);
      });
      for (const t of targets) {
        if (isSubtitleFile(t)) {
          state.subtitleDirs.add(path.dirname(t));
          if (SIDECAR_SUBFOLDER.test(path.basename(path.dirname(t)))) state.subtitleDirs.add(path.dirname(path.dirname(t)));
        } else if (isSidecarMetadataFile(t)) {
          state.metadataDirs.add(path.dirname(t));
        }
      }
      const walk = await walkTargets(targets, signal);
      walkedFiles = walk.files;
      dirMtimes = walk.dirs;
      gone = walk.gone;
      walk.errors.forEach((e) => state.error(e));
      // New folders may arrive with subtitles/artwork already inside.
      for (const dir of walk.dirs.keys()) {
        state.subtitleDirs.add(dir);
        state.metadataDirs.add(dir);
      }
    }

    // ── classify ─────────────────────────────────────────────────────────────
    const seen = new Set<string>();
    const pending: Pending[] = [];
    for (const walked of walkedFiles) {
      const root = rootOf(walked.path);
      if (!root || isInSkippedDir(walked.path, root)) continue;
      const key = pathKey(walked.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const ex = byKey.get(key);
      const changed =
        !ex ||
        ex.missing ||
        ex.sizeBytes !== walked.size ||
        ex.mtimeMs !== walked.mtimeMs ||
        (ex.probedAt === null && ex.probeError !== null && this.deps.probeAvailable());
      if (changed) pending.push({ walked, root, existing: ex });
      else {
        state.files.unchanged++;
        // Keep reporting unreadable files on every full scan until they are fixed.
        if (full && ex.probedAt && ex.probeError) {
          state.error(`Could not read media info of ${ex.path}: ${probeErrorSummary(ex.path, ex.probeError)}`);
        }
      }
    }

    const toDelete: MediaFile[] = [];
    const toMarkMissing: MediaFile[] = [];
    if (full) {
      for (const f of existing) {
        if (seen.has(pathKey(f.path))) continue;
        const root = rootOf(f.path);
        if (root && unsafeRoots.has(pathKey(root))) {
          if (!f.missing) toMarkMissing.push(f);
        } else {
          toDelete.push(f);
        }
      }
    } else {
      for (const g of gone) {
        for (const f of existing) {
          if (!f.missing && !seen.has(pathKey(f.path)) && isPathInside(f.path, g)) toMarkMissing.push(f);
        }
      }
    }

    // ── 2. probe ─────────────────────────────────────────────────────────────
    let probed = 0;
    onProgress({ phase: 'probing', processed: 0, total: pending.length });
    const probes = await mapLimit(
      pending,
      this.deps.probeConcurrency,
      async (p): Promise<ProbeOutcome> => {
        try {
          return { probe: await this.deps.probe(p.walked.path, signal) };
        } catch (err) {
          signal.throwIfAborted();
          return { error: errorMessage(err), unavailable: err instanceof ProbeUnavailableError };
        } finally {
          onProgress({ phase: 'probing', processed: ++probed, total: pending.length, current: p.walked.path });
        }
      },
      signal,
    );

    // ── 3. save ──────────────────────────────────────────────────────────────
    for (let i = 0; i < pending.length; i++) {
      signal.throwIfAborted();
      const p = pending[i]!;
      onProgress({ phase: 'saving', processed: i, total: pending.length, current: p.walked.path });
      const { identity, parsed } = identifyFile(p.walked.path, p.root, library.type);
      if (!identity) {
        if (state.unidentified.length < MAX_LISTED) state.unidentified.push(p.walked.path);
        continue;
      }
      const outcome = probes[i]!;
      if ('error' in outcome && !outcome.unavailable) {
        state.error(`Could not read media info of ${p.walked.path}: ${probeErrorSummary(p.walked.path, outcome.error)}`);
      }
      try {
        this.saveFile(library, p, identity, parsed, outcome, state);
      } catch (err) {
        state.error(`${p.walked.path}: ${errorMessage(err)}`);
        log.warn({ file: p.walked.path, err }, 'Could not save media file');
      }
      if (i % 200 === 199) await yieldToEventLoop();
    }

    if (toMarkMissing.length) {
      for (const ids of chunk(toMarkMissing.map((f) => f.id))) {
        this.db.update(mediaFiles).set({ missing: true }).where(inArray(mediaFiles.id, ids)).run();
      }
      state.files.missing = toMarkMissing.length;
    }

    // ── 4. cleanup ───────────────────────────────────────────────────────────
    onProgress({ phase: 'cleanup', processed: 0, total: toDelete.length });
    if (toDelete.length) {
      const ids = toDelete.map((f) => f.id);
      await this.deps.onFilesRemoved?.(ids);
      for (const part of chunk(ids)) this.db.delete(mediaFiles).where(inArray(mediaFiles.id, part)).run();
      state.files.removed = toDelete.length;
      for (const f of toDelete) if (!state.createdItems.has(f.mediaItemId)) state.updatedItems.add(f.mediaItemId);
    }
    this.removeOrphans(library.id, state);
    for (const r of state.removedItems) state.updatedItems.delete(r.id);

    // ── 5. metadata ──────────────────────────────────────────────────────────
    await this.matchItems(library, request, state, signal, onProgress, log);

    // ── 6. subtitles ─────────────────────────────────────────────────────────
    const since = full ? (library.lastScannedAt?.getTime() ?? 0) : Number.POSITIVE_INFINITY;
    await this.syncSubtitlesFor(library, state, dirMtimes, since, signal, onProgress);

    // ── 7. finish ────────────────────────────────────────────────────────────
    const finishedAt = new Date();
    if (full) this.db.update(libraries).set({ lastScannedAt: startedAt }).where(eq(libraries.id, library.id)).run();

    const summary: ScanSummary = {
      kind: request.kind,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      added: state.createdItems.size,
      updated: state.updatedItems.size,
      removed: state.removedItems.length,
      files: state.files,
      unidentified: state.unidentified,
      errors: state.errors,
    };
    this.deps.events.emit('scan.completed', {
      libraryId: library.id,
      added: summary.added,
      updated: summary.updated,
      removed: summary.removed,
    });
    if (summary.added || summary.updated || summary.removed) this.dispatchPostScan(library, state, startedAt, finishedAt);
    log.info({ ...summary, unidentified: summary.unidentified.length, errors: summary.errors.length }, 'Scan finished');
    return summary;
  }

  /** Re-runs metadata agents for one item (admin "Refresh" / "Fix match"). */
  async refreshItem(
    itemId: number,
    options: { rematch?: boolean; externalIds?: Record<string, string>; lock?: boolean; signal?: AbortSignal } = {},
  ): Promise<MediaItem> {
    const item = this.db.select().from(mediaItems).where(eq(mediaItems.id, itemId)).get();
    if (!item) throw new Error(`Item ${itemId} not found`);
    const library = this.db.select().from(libraries).where(eq(libraries.id, item.libraryId)).get()!;
    const updated = await refreshItemMetadata(this.metadataDeps, library, item, options);
    if (options.lock !== undefined && options.lock !== updated.locked) {
      return this.db.update(mediaItems).set({ locked: options.lock }).where(eq(mediaItems.id, itemId)).returning().get();
    }
    return updated;
  }

  // ── saving ─────────────────────────────────────────────────────────────────

  private findOrCreateItem(library: Library, identity: FileIdentity, state: ScanState): MediaItem {
    const { item } = identity;
    const found = this.db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.libraryId, library.id), eq(mediaItems.kind, identity.kind), eq(mediaItems.matchKey, item.matchKey)))
      .get();
    if (found) {
      if (!found.folderPath && item.folderPath) {
        return this.db.update(mediaItems).set({ folderPath: item.folderPath }).where(eq(mediaItems.id, found.id)).returning().get();
      }
      return found;
    }
    const created = this.db
      .insert(mediaItems)
      .values({
        libraryId: library.id,
        kind: identity.kind,
        title: item.title,
        sortTitle: sortTitleOf(item.title),
        year: item.year ?? null,
        matchKey: item.matchKey,
        folderPath: item.folderPath,
        externalIds: item.externalIds ?? {},
      })
      .returning()
      .get();
    state.createdItems.add(created.id);
    return created;
  }

  private findOrCreateEpisode(show: MediaItem, identity: Extract<FileIdentity, { kind: 'show' }>, state: ScanState): number {
    const { season: seasonNumber, episode: episodeNumber } = identity;
    let season = this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.showId, show.id), eq(seasons.seasonNumber, seasonNumber)))
      .get();
    season ??= this.db.insert(seasons).values({ showId: show.id, seasonNumber }).returning().get();

    const existing = this.db
      .select()
      .from(episodes)
      .where(and(eq(episodes.showId, show.id), eq(episodes.seasonNumber, seasonNumber), eq(episodes.episodeNumber, episodeNumber)))
      .get();
    if (existing) {
      const end = identity.episodeEnd ?? null;
      const abs = identity.absoluteNumber ?? existing.absoluteNumber;
      if (existing.episodeNumberEnd !== end || existing.absoluteNumber !== abs) {
        this.db.update(episodes).set({ episodeNumberEnd: end, absoluteNumber: abs }).where(eq(episodes.id, existing.id)).run();
      }
      return existing.id;
    }
    const created = this.db
      .insert(episodes)
      .values({
        showId: show.id,
        seasonId: season.id,
        seasonNumber,
        episodeNumber,
        episodeNumberEnd: identity.episodeEnd ?? null,
        absoluteNumber: identity.absoluteNumber ?? null,
      })
      .returning()
      .get();
    const set = state.newSeasons.get(show.id) ?? new Set<number>();
    set.add(seasonNumber);
    state.newSeasons.set(show.id, set);
    return created.id;
  }

  private saveFile(
    library: Library,
    p: Pending,
    identity: FileIdentity,
    parsed: ParsedFileName,
    outcome: ProbeOutcome,
    state: ScanState,
  ): void {
    this.db.transaction(() => {
      // Another library may already own this path (overlapping folders): leave it there.
      if (!p.existing) {
        const owner = this.db
          .select({ libraryId: mediaFiles.libraryId })
          .from(mediaFiles)
          .where(eq(mediaFiles.path, p.walked.path))
          .get();
        if (owner) throw new Error(`already belongs to library ${owner.libraryId}`);
      }

      const item = this.findOrCreateItem(library, identity, state);
      const episodeId = identity.kind === 'show' ? this.findOrCreateEpisode(item, identity, state) : null;
      const probe = 'probe' in outcome ? outcome.probe : null;

      const values = {
        libraryId: library.id,
        mediaItemId: item.id,
        episodeId,
        path: p.walked.path,
        sizeBytes: p.walked.size,
        mtimeMs: p.walked.mtimeMs,
        container: probe?.container ?? null,
        durationSeconds: probe?.durationSeconds ?? null,
        bitrate: probe?.bitrate ?? null,
        videoCodec: probe?.videoCodec ?? null,
        videoProfile: probe?.videoProfile ?? null,
        width: probe?.width ?? null,
        height: probe?.height ?? null,
        frameRate: probe?.frameRate ?? null,
        bitDepth: probe?.bitDepth ?? null,
        resolution: probe?.resolution ?? parsed.resolution ?? null,
        hdr: probe?.hdr ?? null,
        audioCodec: probe?.audioCodec ?? null,
        audioChannels: probe?.audioChannels ?? null,
        streams: probe?.streams ?? [],
        edition: parsed.edition ?? null,
        source: parsed.source ?? null,
        releaseGroup: parsed.releaseGroup ?? null,
        parsed,
        // Unavailable ffprobe → probedAt stays null so the next scan retries; real failures are not retried until the file changes.
        probedAt: 'error' in outcome && outcome.unavailable ? null : new Date(),
        probeError: 'error' in outcome ? outcome.error.slice(0, 1000) : null,
        missing: false,
      };

      let fileId: number;
      if (p.existing) {
        this.db.update(mediaFiles).set(values).where(eq(mediaFiles.id, p.existing.id)).run();
        fileId = p.existing.id;
        state.files.updated++;
        if (p.existing.mediaItemId !== item.id && !state.createdItems.has(p.existing.mediaItemId)) {
          state.updatedItems.add(p.existing.mediaItemId);
        }
      } else {
        fileId = this.db.insert(mediaFiles).values(values).returning({ id: mediaFiles.id }).get().id;
        state.files.added++;
      }
      state.savedFiles.add(fileId);
      if (!state.createdItems.has(item.id)) state.updatedItems.add(item.id);
    });
  }

  /** Deletes episodes, seasons and items left without files. */
  private removeOrphans(libraryId: number, state: ScanState): void {
    const showIds = sql`(SELECT ${mediaItems.id} FROM ${mediaItems} WHERE ${mediaItems.libraryId} = ${libraryId})`;
    this.db.transaction((tx) => {
      tx.delete(episodes)
        .where(
          and(
            sql`${episodes.showId} IN ${showIds}`,
            sql`NOT EXISTS (SELECT 1 FROM ${mediaFiles} WHERE ${mediaFiles.episodeId} = ${episodes.id})`,
          ),
        )
        .run();
      tx.delete(seasons)
        .where(
          and(
            sql`${seasons.showId} IN ${showIds}`,
            sql`NOT EXISTS (SELECT 1 FROM ${episodes} WHERE ${episodes.seasonId} = ${seasons.id})`,
          ),
        )
        .run();
      const orphanItems = sql`${mediaItems.libraryId} = ${libraryId} AND NOT EXISTS (SELECT 1 FROM ${mediaFiles} WHERE ${mediaFiles.mediaItemId} = ${mediaItems.id})`;
      const doomed = tx
        .select({ id: mediaItems.id, kind: mediaItems.kind, title: mediaItems.title })
        .from(mediaItems)
        .where(orphanItems)
        .all();
      if (doomed.length) tx.delete(mediaItems).where(orphanItems).run();
      for (const d of doomed) {
        if (state.createdItems.delete(d.id)) continue; // created and emptied in one scan: never existed
        state.removedItems.push(d);
      }
    });
  }

  // ── metadata ───────────────────────────────────────────────────────────────

  private async matchItems(
    library: Library,
    request: ScanRequest,
    state: ScanState,
    signal: AbortSignal,
    onProgress: (p: ScanProgress) => void,
    log: Logger,
  ): Promise<void> {
    const items = this.db.select().from(mediaItems).where(eq(mediaItems.libraryId, library.id)).all();
    const providers = this.deps.metadata.providers(library.agents).map((p) => p.id);
    if (!providers.length) return;
    const providerUpdated = new Map(
      this.db
        .select({ id: pluginsTable.id, configuredAt: pluginsTable.configuredAt })
        .from(pluginsTable)
        .all()
        .map((r) => [r.id, r.configuredAt?.getTime() ?? 0]),
    );
    const now = Date.now();

    // NFO/artwork changed inside an item's own folder (movie folder, show root or one of its seasons).
    const touchesMetadataDir = (item: MediaItem): boolean => {
      if (!item.folderPath || !state.metadataDirs.size) return false;
      for (const dir of state.metadataDirs) if (isPathInside(dir, item.folderPath)) return true;
      return false;
    };

    const fullRefresh = (item: MediaItem): boolean => {
      if (state.createdItems.has(item.id) || request.refreshMetadata) return true;
      if (touchesMetadataDir(item)) return true;
      // Retries only on full scans: watcher-triggered scans must stay cheap.
      if (item.locked || request.kind !== 'full') return false;
      const attempted = item.metadataUpdatedAt?.getTime();
      if (attempted === undefined) return true;
      if (item.metadataSources.length === 0 && now - attempted > UNMATCHED_RETRY_MS) return true;
      // A provider was configured/enabled/upgraded after this item was matched and has never contributed.
      return providers.some((id) => (providerUpdated.get(id) ?? 0) > attempted && !item.metadataSources.includes(id));
    };

    const work: Array<{ item: MediaItem; seasonsOnly?: number[] }> = [];
    for (const item of items) {
      if (fullRefresh(item)) work.push({ item });
      else if (item.kind === 'show' && state.newSeasons.has(item.id)) work.push({ item, seasonsOnly: [...state.newSeasons.get(item.id)!] });
    }

    for (let i = 0; i < work.length; i++) {
      signal.throwIfAborted();
      const { item, seasonsOnly } = work[i]!;
      onProgress({ phase: 'metadata', processed: i, total: work.length, current: item.title });
      try {
        if (seasonsOnly) {
          await refreshSeasons(this.metadataDeps, library, item, seasonsOnly, signal);
          this.deps.events.emit('metadata.updated', { mediaItemId: item.id });
        } else {
          await refreshItemMetadata(this.metadataDeps, library, item, { signal });
        }
        if (!state.createdItems.has(item.id)) state.updatedItems.add(item.id);
      } catch (err) {
        signal.throwIfAborted();
        state.error(`Metadata for "${item.title}": ${errorMessage(err)}`);
        log.warn({ item: item.id, err }, 'Metadata refresh failed');
      }
    }
  }

  // ── subtitles ──────────────────────────────────────────────────────────────

  private async syncSubtitlesFor(
    library: Library,
    state: ScanState,
    dirMtimes: Map<string, number>,
    since: number,
    signal: AbortSignal,
    onProgress: (p: ScanProgress) => void,
  ): Promise<void> {
    const files = this.db
      .select()
      .from(mediaFiles)
      .where(and(eq(mediaFiles.libraryId, library.id), eq(mediaFiles.missing, false)))
      .all();

    // Folders changed since the last scan (a subtitle added/removed changes its folder's mtime).
    const changedDirs = new Set<string>();
    if (Number.isFinite(since)) {
      for (const [dir, mtime] of dirMtimes) {
        if (mtime <= since) continue;
        changedDirs.add(pathKey(dir));
        if (SIDECAR_SUBFOLDER.test(path.basename(dir))) changedDirs.add(pathKey(path.dirname(dir)));
      }
    }
    for (const dir of state.subtitleDirs) changedDirs.add(pathKey(dir));

    const siblings = new Map<string, string[]>();
    for (const f of files) {
      const key = pathKey(path.dirname(f.path));
      siblings.set(key, [...(siblings.get(key) ?? []), f.path]);
    }

    const targets = files.filter((f) => state.savedFiles.has(f.id) || changedDirs.has(pathKey(path.dirname(f.path))));
    let done = 0;
    onProgress({ phase: 'subtitles', processed: 0, total: targets.length });
    await mapLimit(
      targets,
      SUBTITLE_CONCURRENCY,
      async (file) => {
        try {
          await this.syncSubtitles(file, siblings.get(pathKey(path.dirname(file.path))) ?? [file.path], signal);
        } catch (err) {
          signal.throwIfAborted();
          state.error(`Subtitles for ${file.path}: ${errorMessage(err)}`);
        }
        onProgress({ phase: 'subtitles', processed: ++done, total: targets.length, current: file.path });
      },
      signal,
    );
  }

  /** Replaces a file's discovered subtitle tracks (downloaded ones are kept). */
  async syncSubtitles(file: MediaFile, siblingVideoPaths: string[], signal?: AbortSignal): Promise<void> {
    const tracks = await this.deps.subtitles.discover(
      { ...toFileInfo(file), siblingVideoPaths: siblingVideoPaths.filter(isVideoFile) },
      signal,
    );
    signal?.throwIfAborted();
    const keys = new Set(tracks.map((t) => t.sourceKey));
    this.db.transaction((tx) => {
      const current = tx.select().from(subtitleTracks).where(eq(subtitleTracks.mediaFileId, file.id)).all();
      const stale = current.filter((t) => t.source !== 'downloaded' && !keys.has(t.sourceKey)).map((t) => t.id);
      if (stale.length) tx.delete(subtitleTracks).where(inArray(subtitleTracks.id, stale)).run();
      for (const t of tracks) {
        const values = {
          source: t.source,
          streamIndex: t.streamIndex ?? null,
          path: t.path ?? null,
          codec: t.codec,
          language: t.language ?? null,
          label: t.label ?? null,
          forced: t.forced === true,
          hearingImpaired: t.hearingImpaired === true,
          isDefault: t.default === true,
          renderable: t.renderable !== false,
          providerId: t.providerId,
        };
        tx.insert(subtitleTracks)
          .values({ mediaFileId: file.id, sourceKey: t.sourceKey, ...values })
          .onConflictDoUpdate({ target: [subtitleTracks.mediaFileId, subtitleTracks.sourceKey], set: values })
          .run();
      }
    });
  }

  // ── post-scan ──────────────────────────────────────────────────────────────

  private dispatchPostScan(library: Library, state: ScanState, startedAt: Date, finishedAt: Date): void {
    const refs = (ids: Set<number>): ScannedItemRef[] => {
      const out: ScannedItemRef[] = [];
      for (const part of chunk([...ids])) {
        const items = this.db.select().from(mediaItems).where(inArray(mediaItems.id, part)).all();
        const files = this.db.select().from(mediaFiles).where(inArray(mediaFiles.mediaItemId, part)).all();
        for (const item of items) {
          out.push({
            id: item.id,
            kind: item.kind,
            title: item.title,
            year: item.year ?? undefined,
            externalIds: item.externalIds,
            files: files.filter((f) => f.mediaItemId === item.id && !f.missing).map(toFileInfo),
          });
        }
      }
      return out;
    };
    const event: ScanCompletedEvent = {
      library: { id: library.id, name: library.name, type: library.type, paths: library.paths },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      added: refs(state.createdItems),
      updated: refs(state.updatedItems),
      removed: state.removedItems,
    };
    this.deps.postScan.dispatch(event).catch((err: unknown) => this.deps.log.warn({ err }, 'Post-scan dispatch failed'));
  }
}
