import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { libraries, musicAlbums, musicArtists, musicTracks, type Library, type MusicTrack } from '../db/schema.js';
import { chunk, mapLimit, yieldToEventLoop } from '../lib/async.js';
import { errorMessage } from '../lib/errors.js';
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { isPathInside } from '../lib/paths.js';
import { extOf, IMAGE_EXTENSIONS, isSkippedMusicDir } from '../media/extensions.js';
import type { MediaProbe } from '../media/probe.js';
import type { ScanProgress, ScanRequest, ScanSummary } from '../scanner/scanner.js';
import { MUSIC_FILTER, pathKey, walkRoots, walkTargets, type WalkedFile } from '../scanner/walk.js';
import { findAlbumCover, findArtistImage } from './artwork.js';
import { DISC_FOLDER, musicKeyOf, musicSortOf, readTrackTags, VARIOUS_ARTISTS, type TrackTags } from './tags.js';

export interface MusicScannerDeps {
  db: DB;
  log: Logger;
  events: EventBus;
  probe: (file: string, signal: AbortSignal) => Promise<MediaProbe>;
  probeAvailable: () => boolean;
  probeConcurrency: number;
  /** Thrown by `probe` when ffprobe is not installed. */
  isProbeUnavailable: (err: unknown) => boolean;
}

const MAX_LISTED = 50;

/** Audio-only containers, from the extension (ffprobe's names are video-oriented). */
const CONTAINER_BY_EXT: Record<string, string> = {
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.m4a': 'mp4',
  '.alac': 'mp4',
  '.aac': 'aac',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.wav': 'wav',
  '.wma': 'asf',
  '.aif': 'aiff',
  '.aiff': 'aiff',
  '.ape': 'ape',
  '.wv': 'wv',
  '.mka': 'mka',
  '.mpc': 'mpc',
  '.dsf': 'dsf',
  '.dff': 'dff',
};

type ProbeOutcome = { probe: MediaProbe } | { error: string; unavailable: boolean };

interface Pending {
  walked: WalkedFile;
  root: string;
  existing?: MusicTrack;
}

/** The album's own folder: the parent of a `CD1`/`Disc 2` folder. */
function albumFolderOf(file: string, root: string): string {
  const dir = path.dirname(file);
  return DISC_FOLDER.test(path.basename(dir)) && isPathInside(path.dirname(dir), root) ? path.dirname(dir) : dir;
}

class ScanState {
  createdAlbums = new Set<number>();
  touchedAlbums = new Set<number>();
  touchedArtists = new Set<number>();
  /** Folders where an image changed (partial scans): their albums' covers are re-checked. */
  imageDirs = new Set<string>();
  removedAlbums = 0;
  errors: string[] = [];
  unidentified: string[] = [];
  files = { added: 0, updated: 0, removed: 0, missing: 0, unchanged: 0 };

  error(message: string): void {
    if (this.errors.length < MAX_LISTED) this.errors.push(message);
  }
}

/**
 * Scans music libraries: reads tags with ffprobe and files tracks under
 * artists and albums. Metadata plugins are not involved.
 */
export class MusicScanner {
  constructor(private readonly deps: MusicScannerDeps) {}

  private get db(): DB {
    return this.deps.db;
  }

  async scan(
    library: Library,
    request: ScanRequest,
    signal: AbortSignal,
    onProgress: (p: ScanProgress) => void = () => undefined,
  ): Promise<ScanSummary> {
    const startedAt = new Date();
    const state = new ScanState();
    const full = request.kind === 'full';
    const roots = library.paths;
    const rootOf = (p: string) => roots.find((r) => isPathInside(p, r));
    const log = this.deps.log.child({ library: library.id, scan: request.kind, music: true });
    const inSkippedDir = (file: string, root: string) =>
      path
        .relative(root, path.dirname(file))
        .split(/[\\/]/)
        .filter(Boolean)
        .some(isSkippedMusicDir);

    // ── discover ─────────────────────────────────────────────────────────────
    onProgress({ phase: 'discovering', processed: 0, total: 0 });
    const existing = this.db.select().from(musicTracks).where(eq(musicTracks.libraryId, library.id)).all();
    const byKey = new Map(existing.map((t) => [pathKey(t.path), t]));
    const unsafeRoots = new Set<string>();
    let walked: WalkedFile[];
    let gone: string[] = [];

    if (full) {
      const walk = await walkRoots(roots, signal, MUSIC_FILTER);
      walked = walk.files;
      walk.errors.forEach((e) => state.error(e));
      for (const r of walk.unreadableRoots) {
        unsafeRoots.add(pathKey(r));
        state.error(`Library folder is not readable: ${r}`);
      }
      for (const r of walk.emptyRoots) {
        if (existing.some((t) => isPathInside(t.path, r))) {
          unsafeRoots.add(pathKey(r));
          state.error(`Library folder is empty, keeping its tracks until it is back: ${r}`);
        }
      }
    } else {
      const targets = (request.paths ?? []).filter((p) => {
        const root = rootOf(p);
        return !!root && !inSkippedDir(p, root);
      });
      for (const t of targets) if (IMAGE_EXTENSIONS.has(extOf(t))) state.imageDirs.add(pathKey(path.dirname(t)));
      const walk = await walkTargets(targets, signal, MUSIC_FILTER);
      walked = walk.files;
      gone = walk.gone;
      walk.errors.forEach((e) => state.error(e));
      // A new folder may arrive with its cover already inside.
      for (const dir of walk.dirs.keys()) state.imageDirs.add(pathKey(dir));
    }

    // ── classify ─────────────────────────────────────────────────────────────
    const seen = new Set<string>();
    const pending: Pending[] = [];
    for (const w of walked) {
      const root = rootOf(w.path);
      if (!root || inSkippedDir(w.path, root)) continue;
      const key = pathKey(w.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const ex = byKey.get(key);
      const changed =
        !ex ||
        ex.missing ||
        ex.sizeBytes !== w.size ||
        ex.mtimeMs !== w.mtimeMs ||
        request.refreshMetadata === true ||
        (ex.probedAt === null && ex.probeError !== null && this.deps.probeAvailable());
      if (changed) pending.push({ walked: w, root, existing: ex });
      else state.files.unchanged++;
    }

    const toDelete: MusicTrack[] = [];
    const toMarkMissing: MusicTrack[] = [];
    if (full) {
      for (const t of existing) {
        if (seen.has(pathKey(t.path))) continue;
        const root = rootOf(t.path);
        if (root && unsafeRoots.has(pathKey(root))) {
          if (!t.missing) toMarkMissing.push(t);
        } else {
          toDelete.push(t);
        }
      }
    } else {
      for (const g of gone) {
        for (const t of existing) if (!t.missing && !seen.has(pathKey(t.path)) && isPathInside(t.path, g)) toMarkMissing.push(t);
      }
    }

    // ── probe ────────────────────────────────────────────────────────────────
    let probed = 0;
    onProgress({ phase: 'probing', processed: 0, total: pending.length });
    const outcomes = await mapLimit(
      pending,
      this.deps.probeConcurrency,
      async (p): Promise<ProbeOutcome> => {
        try {
          return { probe: await this.deps.probe(p.walked.path, signal) };
        } catch (err) {
          signal.throwIfAborted();
          return { error: errorMessage(err), unavailable: this.deps.isProbeUnavailable(err) };
        } finally {
          onProgress({ phase: 'probing', processed: ++probed, total: pending.length, current: p.walked.path });
        }
      },
      signal,
    );

    // ── save ─────────────────────────────────────────────────────────────────
    const tagged = pending.map((p, i) => {
      const outcome = outcomes[i]!;
      return readTrackTags('probe' in outcome ? outcome.probe.tags : undefined, p.walked.path, p.root);
    });
    markCompilations(pending, tagged);

    for (let i = 0; i < pending.length; i++) {
      signal.throwIfAborted();
      const p = pending[i]!;
      const outcome = outcomes[i]!;
      onProgress({ phase: 'saving', processed: i, total: pending.length, current: p.walked.path });
      if ('error' in outcome && !outcome.unavailable) {
        state.error(`Could not read ${p.walked.path}: ${outcome.error.trim().split(/\r?\n/).at(-1) ?? outcome.error}`);
      }
      try {
        this.saveTrack(library, p, tagged[i]!, outcome, state);
      } catch (err) {
        state.error(`${p.walked.path}: ${errorMessage(err)}`);
        log.warn({ file: p.walked.path, err }, 'Could not save track');
      }
      if (i % 200 === 199) await yieldToEventLoop();
    }

    if (toMarkMissing.length) {
      for (const ids of chunk(toMarkMissing.map((t) => t.id))) {
        this.db.update(musicTracks).set({ missing: true }).where(inArray(musicTracks.id, ids)).run();
      }
      state.files.missing = toMarkMissing.length;
    }

    // ── cleanup ──────────────────────────────────────────────────────────────
    onProgress({ phase: 'cleanup', processed: 0, total: toDelete.length });
    for (const part of chunk(toDelete.map((t) => t.id))) this.db.delete(musicTracks).where(inArray(musicTracks.id, part)).run();
    state.files.removed = toDelete.length;
    for (const t of toDelete) state.touchedAlbums.add(t.albumId);
    this.removeOrphans(library.id, state);

    // ── albums: covers, genres, years ────────────────────────────────────────
    await this.finishAlbums(library, state, signal, onProgress);

    const finishedAt = new Date();
    if (full) this.db.update(libraries).set({ lastScannedAt: startedAt }).where(eq(libraries.id, library.id)).run();
    const createdAlbums = [...state.createdAlbums].filter((id) => this.albumExists(id)).length;
    const summary: ScanSummary = {
      kind: request.kind,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      added: createdAlbums,
      updated: Math.max(0, [...state.touchedAlbums].filter((id) => !state.createdAlbums.has(id) && this.albumExists(id)).length),
      removed: state.removedAlbums,
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
    log.info({ ...summary, errors: summary.errors.length }, 'Music scan finished');
    return summary;
  }

  private albumExists(id: number): boolean {
    return !!this.db.select({ id: musicAlbums.id }).from(musicAlbums).where(eq(musicAlbums.id, id)).get();
  }

  // ── saving ─────────────────────────────────────────────────────────────────

  private artistId(libraryId: number, name: string, state: ScanState): number {
    const matchKey = musicKeyOf(name);
    const found = this.db
      .select({ id: musicArtists.id })
      .from(musicArtists)
      .where(and(eq(musicArtists.libraryId, libraryId), eq(musicArtists.matchKey, matchKey)))
      .get();
    const id =
      found?.id ??
      this.db
        .insert(musicArtists)
        .values({ libraryId, name, sortName: musicSortOf(name), matchKey })
        .returning({ id: musicArtists.id })
        .get().id;
    state.touchedArtists.add(id);
    return id;
  }

  private albumId(libraryId: number, artistId: number, tags: TrackTags, folder: string, state: ScanState): number {
    const matchKey = musicKeyOf(tags.album);
    const found = this.db
      .select({ id: musicAlbums.id, year: musicAlbums.year })
      .from(musicAlbums)
      .where(and(eq(musicAlbums.libraryId, libraryId), eq(musicAlbums.artistId, artistId), eq(musicAlbums.matchKey, matchKey)))
      .get();
    if (found) {
      state.touchedAlbums.add(found.id);
      return found.id;
    }
    const created = this.db
      .insert(musicAlbums)
      .values({
        libraryId,
        artistId,
        title: tags.album,
        sortTitle: musicSortOf(tags.album),
        matchKey,
        year: tags.year,
        genres: tags.genres,
        folderPath: folder,
      })
      .returning({ id: musicAlbums.id })
      .get();
    state.createdAlbums.add(created.id);
    state.touchedAlbums.add(created.id);
    return created.id;
  }

  private saveTrack(library: Library, p: Pending, tags: TrackTags, outcome: ProbeOutcome, state: ScanState): void {
    const probe = 'probe' in outcome ? outcome.probe : null;
    const audio = probe?.streams.find((s) => s.type === 'audio' && s.default) ?? probe?.streams.find((s) => s.type === 'audio');
    if (probe && !audio) {
      if (state.unidentified.length < MAX_LISTED) state.unidentified.push(p.walked.path);
      return;
    }
    this.db.transaction(() => {
      if (!p.existing) {
        const owner = this.db
          .select({ libraryId: musicTracks.libraryId })
          .from(musicTracks)
          .where(eq(musicTracks.path, p.walked.path))
          .get();
        if (owner) throw new Error(`already belongs to library ${owner.libraryId}`);
      }
      const albumArtistId = this.artistId(library.id, tags.albumArtist, state);
      const trackArtistId =
        musicKeyOf(tags.primaryArtist) === musicKeyOf(tags.albumArtist) ? albumArtistId : this.artistId(library.id, tags.primaryArtist, state);
      const albumId = this.albumId(library.id, albumArtistId, tags, albumFolderOf(p.walked.path, p.root), state);

      const values = {
        libraryId: library.id,
        albumId,
        artistId: trackArtistId,
        artistName: tags.artist,
        title: tags.title,
        sortTitle: musicSortOf(tags.title),
        trackNumber: tags.trackNumber,
        discNumber: tags.discNumber,
        year: tags.year,
        genres: tags.genres,
        durationSeconds: probe?.durationSeconds ?? null,
        path: p.walked.path,
        sizeBytes: p.walked.size,
        mtimeMs: p.walked.mtimeMs,
        container: CONTAINER_BY_EXT[extOf(p.walked.path)] ?? null,
        codec: audio?.codec ?? null,
        bitrate: probe?.bitrate ?? audio?.bitRate ?? null,
        sampleRate: audio?.sampleRate ?? null,
        channels: audio?.channels ?? null,
        hasEmbeddedArt: !!probe?.streams.some((s) => s.type === 'attachment' || s.type === 'video'),
        probedAt: 'error' in outcome && outcome.unavailable ? null : new Date(),
        probeError: 'error' in outcome ? outcome.error.slice(0, 1000) : null,
        missing: false,
      };
      if (p.existing) {
        this.db.update(musicTracks).set(values).where(eq(musicTracks.id, p.existing.id)).run();
        state.files.updated++;
        if (p.existing.albumId !== albumId) state.touchedAlbums.add(p.existing.albumId);
      } else {
        this.db.insert(musicTracks).values(values).run();
        state.files.added++;
      }
    });
  }

  /** Albums without tracks, then artists without albums or tracks. */
  private removeOrphans(libraryId: number, state: ScanState): void {
    this.db.transaction((tx) => {
      const orphanAlbums = sql`${musicAlbums.libraryId} = ${libraryId} AND NOT EXISTS (SELECT 1 FROM ${musicTracks} WHERE ${musicTracks.albumId} = ${musicAlbums.id})`;
      const doomed = tx.select({ id: musicAlbums.id }).from(musicAlbums).where(orphanAlbums).all();
      if (doomed.length) tx.delete(musicAlbums).where(orphanAlbums).run();
      for (const d of doomed) {
        state.touchedAlbums.delete(d.id);
        if (!state.createdAlbums.delete(d.id)) state.removedAlbums++;
      }
      tx.delete(musicArtists)
        .where(
          sql`${musicArtists.libraryId} = ${libraryId}
            AND NOT EXISTS (SELECT 1 FROM ${musicAlbums} WHERE ${musicAlbums.artistId} = ${musicArtists.id})
            AND NOT EXISTS (SELECT 1 FROM ${musicTracks} WHERE ${musicTracks.artistId} = ${musicArtists.id})`,
        )
        .run();
    });
  }

  /** Recomputes cover, year and genres of every album the scan touched, and artist images. */
  private async finishAlbums(
    library: Library,
    state: ScanState,
    signal: AbortSignal,
    onProgress: (p: ScanProgress) => void,
  ): Promise<void> {
    const ids = new Set(state.touchedAlbums);
    if (state.imageDirs.size) {
      const all = this.db
        .select({ id: musicAlbums.id, folderPath: musicAlbums.folderPath })
        .from(musicAlbums)
        .where(eq(musicAlbums.libraryId, library.id))
        .all();
      for (const a of all) {
        if (!a.folderPath) continue;
        for (const dir of state.imageDirs) {
          if (isPathInside(dir, pathKey(a.folderPath)) || isPathInside(pathKey(a.folderPath), dir)) ids.add(a.id);
        }
      }
    }
    const albumIds = [...ids];
    const roots = library.paths;
    const artistDirs = new Map<number, string>();
    let done = 0;

    for (const part of chunk(albumIds, 200)) {
      const albums = this.db.select().from(musicAlbums).where(inArray(musicAlbums.id, part)).all();
      const tracks = this.db
        .select({
          albumId: musicTracks.albumId,
          path: musicTracks.path,
          year: musicTracks.year,
          genres: musicTracks.genres,
          hasEmbeddedArt: musicTracks.hasEmbeddedArt,
          discNumber: musicTracks.discNumber,
          trackNumber: musicTracks.trackNumber,
        })
        .from(musicTracks)
        .where(and(inArray(musicTracks.albumId, part), eq(musicTracks.missing, false)))
        .all();

      for (const album of albums) {
        signal.throwIfAborted();
        onProgress({ phase: 'metadata', processed: done++, total: albumIds.length, current: album.title });
        const own = tracks
          .filter((t) => t.albumId === album.id)
          .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
        if (!own.length) continue;

        const folders = [...new Set(own.map((t) => path.dirname(t.path)))];
        const root = roots.find((r) => isPathInside(own[0]!.path, r)) ?? roots[0]!;
        const albumDir = albumFolderOf(own[0]!.path, root);
        const searchDirs = [...new Set([albumDir, ...folders])].filter((d) => isPathInside(d, root) && pathKey(d) !== pathKey(root));
        const folderCover = await findAlbumCover(searchDirs, album.title);
        const embedded = own.find((t) => t.hasEmbeddedArt);
        const cover = folderCover ?? (embedded ? `embedded:${embedded.path}` : null);

        const years = own.map((t) => t.year).filter((y): y is number => !!y);
        const year = years.length ? Math.min(...years) : album.year;
        const genreCount = new Map<string, number>();
        for (const t of own) for (const g of t.genres) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
        const genres = [...genreCount.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([g]) => g);

        if (cover !== album.cover || year !== album.year || JSON.stringify(genres) !== JSON.stringify(album.genres) || albumDir !== album.folderPath) {
          this.db.update(musicAlbums).set({ cover, year, genres, folderPath: albumDir }).where(eq(musicAlbums.id, album.id)).run();
        }
        // Artist/Album layout: the album folder's parent is the album artist's folder.
        const parent = path.dirname(albumDir);
        if (pathKey(parent) !== pathKey(root) && isPathInside(parent, root) && !artistDirs.has(album.artistId)) {
          artistDirs.set(album.artistId, parent);
        }
      }
      await yieldToEventLoop();
    }

    for (const [artistId, dir] of artistDirs) {
      const artist = this.db.select().from(musicArtists).where(eq(musicArtists.id, artistId)).get();
      if (!artist || artist.name === VARIOUS_ARTISTS) continue;
      // Only a folder named after the artist ("Beatles, The" or "The Beatles") is theirs.
      const folderKey = musicKeyOf(path.basename(dir).replace(/^(.*),\s*(the|a|an)$/i, '$2 $1'));
      if (folderKey !== artist.matchKey) continue;
      const image = await findArtistImage(dir);
      if (image !== artist.image) this.db.update(musicArtists).set({ image }).where(eq(musicArtists.id, artistId)).run();
    }
  }
}

/**
 * Untagged compilations: when files in one folder share an album title but
 * have different artists, and none names an album artist, file them under
 * "Various Artists" instead of splitting the album per artist.
 */
function markCompilations(pending: Pending[], tagged: TrackTags[]): void {
  const groups = new Map<string, number[]>();
  pending.forEach((p, i) => {
    const key = `${pathKey(albumFolderOf(p.walked.path, p.root))}|${musicKeyOf(tagged[i]!.album)}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const indexes of groups.values()) {
    if (indexes.length < 2 || indexes.some((i) => tagged[i]!.albumArtistTagged)) continue;
    const artists = new Set(indexes.map((i) => musicKeyOf(tagged[i]!.primaryArtist)));
    if (artists.size < 2) continue;
    for (const i of indexes) tagged[i] = { ...tagged[i]!, albumArtist: VARIOUS_ARTISTS, compilation: true };
  }
}
