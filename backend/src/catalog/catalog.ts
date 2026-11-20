import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  episodes,
  libraries,
  mediaFiles,
  mediaItems,
  seasons,
  watchlist,
  watchProgress,
  type Episode,
  type MediaFile,
  type MediaItem,
  type Profile,
  type WatchProgress,
} from '../db/schema.js';
import { chunk } from '../lib/async.js';
import { canAccess } from './access.js';
import { artworkUrl } from './artwork.js';

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface PlayTarget {
  fileId: number;
  episodeId: number | null;
  /** `S1:E3` for episodes. */
  episodeLabel: string | null;
  episodeTitle: string | null;
  positionSeconds: number;
  durationSeconds: number | null;
  /** True when playback resumes part-way through. */
  resume: boolean;
}

export interface CardDto {
  id: number;
  kind: MediaItem['kind'];
  title: string;
  year: number | null;
  overview: string | null;
  genres: string[];
  contentRating: string | null;
  rating: number | null;
  runtimeMinutes: number | null;
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
  thumb: string | null;
  resolution: string | null;
  hdr: string | null;
  addedAt: string;
  inList: boolean;
  /** Continue-watching rows: where to pick up and how far along it is (0–1). */
  target?: PlayTarget;
  progress?: number;
}

export interface RowDto {
  id: string;
  title: string;
  kind: 'continue' | 'standard';
  items: CardDto[];
}

export interface VersionDto {
  id: number;
  label: string;
  resolution: string | null;
  hdr: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  container: string | null;
  sizeBytes: number;
  durationSeconds: number | null;
  edition: string | null;
}

export type BrowseSort = 'added' | 'title' | 'year' | 'rating' | 'release';

// ── helpers ──────────────────────────────────────────────────────────────────

const RESOLUTION_RANK: Record<string, number> = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, SD: 0 };
const CODEC_NAMES: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2' };
const ROW_SIZE = 24;
const RECENT_WINDOW_MS = 120 * 24 * 60 * 60_000;

const cardColumns = {
  id: mediaItems.id,
  libraryId: mediaItems.libraryId,
  kind: mediaItems.kind,
  title: mediaItems.title,
  sortTitle: mediaItems.sortTitle,
  year: mediaItems.year,
  overview: mediaItems.overview,
  genres: mediaItems.genres,
  contentRating: mediaItems.contentRating,
  rating: mediaItems.rating,
  runtimeMinutes: mediaItems.runtimeMinutes,
  poster: mediaItems.poster,
  backdrop: mediaItems.backdrop,
  logo: mediaItems.logo,
  thumb: mediaItems.thumb,
  releaseDate: mediaItems.releaseDate,
  createdAt: mediaItems.createdAt,
};
type CardRow = { [K in keyof typeof cardColumns]: MediaItem[K] };

/**
 * A file that can be offered for playback: on disk, and not one ffprobe tried
 * and failed to read (damaged or still downloading — re-read once it changes).
 */
const playable = sql`(${mediaFiles.missing} = 0 AND NOT (${mediaFiles.probedAt} IS NOT NULL AND ${mediaFiles.probeError} IS NOT NULL))`;

/** Items with at least one playable file. */
const available = sql`EXISTS (SELECT 1 FROM ${mediaFiles} WHERE ${mediaFiles.mediaItemId} = ${mediaItems.id} AND ${playable})`;

const truncate = (s: string | null, max: number) => (s && s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const episodeLabel = (e: Pick<Episode, 'seasonNumber' | 'episodeNumber' | 'episodeNumberEnd'>) =>
  `S${e.seasonNumber}:E${e.episodeNumber}${e.episodeNumberEnd ? `-${e.episodeNumberEnd}` : ''}`;

export function isComplete(position: number, duration: number | null | undefined): boolean {
  if (!duration || duration <= 0) return false;
  return position >= duration * 0.9 || (duration > 600 && duration - position <= 120);
}

export function versionLabel(f: Pick<MediaFile, 'resolution' | 'videoCodec' | 'hdr' | 'edition'>): string {
  return [f.edition, f.resolution, f.videoCodec ? (CODEC_NAMES[f.videoCodec] ?? f.videoCodec.toUpperCase()) : null, f.hdr]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Default version to play: H.264 near 1080p first (plays directly in every
 * browser), then whatever is closest to 1080p.
 */
export function pickDefaultFile<F extends Pick<MediaFile, 'videoCodec' | 'height' | 'missing'>>(files: F[]): F | undefined {
  const score = (f: F) => (f.missing ? 1e6 : 0) + (f.videoCodec === 'h264' ? 0 : 1e4) + Math.abs((f.height ?? 1080) - 1080);
  return [...files].sort((a, b) => score(a) - score(b))[0];
}

function toVersion(f: MediaFile): VersionDto {
  return {
    id: f.id,
    label: versionLabel(f) || 'Original',
    resolution: f.resolution,
    hdr: f.hdr,
    videoCodec: f.videoCodec,
    audioCodec: f.audioCodec,
    audioChannels: f.audioChannels,
    container: f.container,
    sizeBytes: f.sizeBytes,
    durationSeconds: f.durationSeconds,
    edition: f.edition,
  };
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ── service ──────────────────────────────────────────────────────────────────

export class CatalogService {
  constructor(private readonly db: DB) {}

  // ── cards ──────────────────────────────────────────────────────────────────

  private visibleRows(profile: Profile, where?: SQL): CardRow[] {
    const rows = this.db
      .select(cardColumns)
      .from(mediaItems)
      .where(where ? and(available, where) : available)
      .all();
    return rows.filter((r) => canAccess(profile, r));
  }

  private toCards(profile: Profile, rows: CardRow[]): CardDto[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const badges = new Map<number, { resolution: string | null; hdr: string | null }>();
    const listed = new Set<number>();
    for (const part of chunk(ids)) {
      for (const f of this.db
        .select({ itemId: mediaFiles.mediaItemId, resolution: mediaFiles.resolution, hdr: mediaFiles.hdr })
        .from(mediaFiles)
        .where(and(inArray(mediaFiles.mediaItemId, part), playable))
        .all()) {
        const current = badges.get(f.itemId);
        const rank = RESOLUTION_RANK[f.resolution ?? ''] ?? -1;
        if (!current || rank > (RESOLUTION_RANK[current.resolution ?? ''] ?? -1)) {
          badges.set(f.itemId, { resolution: f.resolution, hdr: f.hdr ?? current?.hdr ?? null });
        } else if (f.hdr && !current.hdr) {
          current.hdr = f.hdr;
        }
      }
      for (const w of this.db
        .select({ id: watchlist.mediaItemId })
        .from(watchlist)
        .where(and(eq(watchlist.profileId, profile.id), inArray(watchlist.mediaItemId, part)))
        .all()) {
        listed.add(w.id);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      year: r.year,
      overview: truncate(r.overview, 320),
      genres: r.genres,
      contentRating: r.contentRating,
      rating: r.rating,
      runtimeMinutes: r.runtimeMinutes,
      poster: artworkUrl('item', r.id, 'poster', r.poster),
      backdrop: artworkUrl('item', r.id, 'backdrop', r.backdrop),
      logo: artworkUrl('item', r.id, 'logo', r.logo),
      thumb: artworkUrl('item', r.id, 'thumb', r.thumb),
      resolution: badges.get(r.id)?.resolution ?? null,
      hdr: badges.get(r.id)?.hdr ?? null,
      addedAt: r.createdAt.toISOString(),
      inList: listed.has(r.id),
    }));
  }

  private sortRows(rows: CardRow[], sort: BrowseSort, descending: boolean): CardRow[] {
    const dir = descending ? -1 : 1;
    const key: Record<BrowseSort, (r: CardRow) => number | string> = {
      added: (r) => r.createdAt.getTime(),
      title: (r) => r.sortTitle,
      year: (r) => r.year ?? 0,
      rating: (r) => r.rating ?? -1,
      release: (r) => r.releaseDate ?? (r.year ? `${r.year}` : ''),
    };
    const k = key[sort];
    return [...rows].sort((a, b) => {
      const x = k(a);
      const y = k(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.sortTitle.localeCompare(b.sortTitle);
    });
  }

  // ── browse ─────────────────────────────────────────────────────────────────

  browse(
    profile: Profile,
    query: { kind?: MediaItem['kind']; genre?: string; libraryId?: number; sort?: BrowseSort; order?: 'asc' | 'desc'; offset?: number; limit?: number },
  ): { total: number; items: CardDto[] } {
    const conditions: SQL[] = [];
    if (query.kind) conditions.push(eq(mediaItems.kind, query.kind));
    if (query.libraryId) conditions.push(eq(mediaItems.libraryId, query.libraryId));
    let rows = this.visibleRows(profile, conditions.length ? and(...conditions) : undefined);
    if (query.genre) {
      const g = query.genre.toLowerCase();
      rows = rows.filter((r) => r.genres.some((x) => x.toLowerCase() === g));
    }
    const sort = query.sort ?? 'title';
    const order = query.order ?? (sort === 'title' ? 'asc' : 'desc');
    const sorted = this.sortRows(rows, sort, order === 'desc');
    const offset = query.offset ?? 0;
    const limit = Math.min(query.limit ?? 60, 200);
    return { total: sorted.length, items: this.toCards(profile, sorted.slice(offset, offset + limit)) };
  }

  genres(profile: Profile, kind?: MediaItem['kind']): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const r of this.visibleRows(profile, kind ? eq(mediaItems.kind, kind) : undefined)) {
      for (const g of r.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  search(profile: Profile, q: string): CardDto[] {
    const pattern = likePattern(q.trim());
    const match = sql`(${mediaItems.title} LIKE ${pattern} ESCAPE '\\' OR ${mediaItems.originalTitle} LIKE ${pattern} ESCAPE '\\'
      OR ${mediaItems.cast} LIKE ${pattern} ESCAPE '\\' OR ${mediaItems.crew} LIKE ${pattern} ESCAPE '\\'
      OR ${mediaItems.genres} LIKE ${pattern} ESCAPE '\\')`;
    const lower = q.trim().toLowerCase();
    const rows = this.visibleRows(profile, match).sort((a, b) => {
      // Title hits first, then by rating.
      const ta = a.title.toLowerCase().includes(lower) ? 0 : 1;
      const tb = b.title.toLowerCase().includes(lower) ? 0 : 1;
      return ta - tb || (b.rating ?? 0) - (a.rating ?? 0) || a.sortTitle.localeCompare(b.sortTitle);
    });
    return this.toCards(profile, rows.slice(0, 80));
  }

  myList(profile: Profile): CardDto[] {
    const ids = this.db
      .select({ id: watchlist.mediaItemId })
      .from(watchlist)
      .where(eq(watchlist.profileId, profile.id))
      .orderBy(desc(watchlist.addedAt))
      .all()
      .map((r) => r.id);
    if (!ids.length) return [];
    const byId = new Map(this.visibleRows(profile, inArray(mediaItems.id, ids)).map((r) => [r.id, r]));
    return this.toCards(profile, ids.map((id) => byId.get(id)).filter((r): r is CardRow => !!r));
  }

  setInList(profile: Profile, itemId: number, inList: boolean): void {
    if (inList) {
      this.db.insert(watchlist).values({ profileId: profile.id, mediaItemId: itemId }).onConflictDoNothing().run();
    } else {
      this.db
        .delete(watchlist)
        .where(and(eq(watchlist.profileId, profile.id), eq(watchlist.mediaItemId, itemId)))
        .run();
    }
  }

  // ── home ───────────────────────────────────────────────────────────────────

  home(profile: Profile): { hero: (Omit<CardDto, 'target'> & { target: PlayTarget | null }) | null; rows: RowDto[] } {
    const all = this.visibleRows(profile);
    const rows: RowDto[] = [];
    const add = (id: string, title: string, items: CardRow[], min = 1) => {
      if (items.length >= min) rows.push({ id, title, kind: 'standard', items: this.toCards(profile, items.slice(0, ROW_SIZE)) });
    };

    const continueItems = this.continueWatching(profile);
    if (continueItems.length) rows.push({ id: 'continue', title: 'Continue Watching', kind: 'continue', items: continueItems });
    const list = this.myList(profile);
    if (list.length) rows.push({ id: 'my-list', title: 'My List', kind: 'standard', items: list.slice(0, ROW_SIZE) });

    const byAdded = this.sortRows(all, 'added', true);
    add('recent', 'Recently Added', byAdded);
    const movies = all.filter((r) => r.kind === 'movie');
    const shows = all.filter((r) => r.kind === 'show');
    if (movies.length && shows.length) {
      add('movies', 'Movies', this.sortRows(movies, 'added', true), 3);
      add('shows', 'TV Shows', this.sortRows(shows, 'added', true), 3);
    }
    add('new', 'New Releases', this.sortRows(all.filter((r) => r.releaseDate || r.year), 'release', true), 6);

    for (const { name } of this.genres(profile).filter((g) => g.count >= 3).slice(0, 8)) {
      add(`genre:${name}`, name, this.sortRows(all.filter((r) => r.genres.includes(name)), 'rating', true), 3);
    }
    add('top', 'Top Rated', this.sortRows(all.filter((r) => (r.rating ?? 0) >= 6.5), 'rating', true), 5);

    // Hero: something recent with a backdrop, varying between visits.
    const candidates = byAdded.filter((r) => r.backdrop && r.overview).slice(0, 12);
    const pick = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)]! : undefined;
    let hero: (Omit<CardDto, 'target'> & { target: PlayTarget | null }) | null = null;
    if (pick) {
      const item = this.db.select().from(mediaItems).where(eq(mediaItems.id, pick.id)).get()!;
      hero = { ...this.toCards(profile, [pick])[0]!, overview: pick.overview, target: this.playTarget(profile, item) };
    }
    return { hero, rows };
  }

  // ── progress ───────────────────────────────────────────────────────────────

  private latestProgress(profile: Profile, itemIds?: number[]): Map<number, WatchProgress> {
    const where = itemIds
      ? and(eq(watchProgress.profileId, profile.id), inArray(watchProgress.mediaItemId, itemIds))
      : eq(watchProgress.profileId, profile.id);
    const latest = new Map<number, WatchProgress>();
    for (const p of this.db.select().from(watchProgress).where(where).orderBy(desc(watchProgress.lastWatchedAt)).all()) {
      if (!latest.has(p.mediaItemId)) latest.set(p.mediaItemId, p);
    }
    return latest;
  }

  /** Episodes of a show that have a file on disk, in viewing order (specials last). */
  private playableEpisodes(showId: number): Episode[] {
    return this.db
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.showId, showId),
          sql`EXISTS (SELECT 1 FROM ${mediaFiles} WHERE ${mediaFiles.episodeId} = ${episodes.id} AND ${playable})`,
        ),
      )
      .orderBy(sql`${episodes.seasonNumber} = 0`, asc(episodes.seasonNumber), asc(episodes.episodeNumber))
      .all();
  }

  private filesFor(where: SQL): MediaFile[] {
    return this.db.select().from(mediaFiles).where(and(where, playable)).all();
  }

  private episodeTarget(e: Episode, progress?: WatchProgress): PlayTarget | null {
    const file =
      (progress?.mediaFileId && this.filesFor(eq(mediaFiles.id, progress.mediaFileId))[0]) ||
      pickDefaultFile(this.filesFor(eq(mediaFiles.episodeId, e.id)));
    if (!file) return null;
    const resume = !!progress && !progress.completed && progress.positionSeconds >= 30;
    return {
      fileId: file.id,
      episodeId: e.id,
      episodeLabel: episodeLabel(e),
      episodeTitle: e.title,
      positionSeconds: resume ? progress!.positionSeconds : 0,
      durationSeconds: file.durationSeconds ?? progress?.durationSeconds ?? null,
      resume,
    };
  }

  /** What "Play" does for an item: resume, next episode, or start from the beginning. */
  playTarget(profile: Profile, item: MediaItem): PlayTarget | null {
    const latest = this.latestProgress(profile, [item.id]).get(item.id);
    if (item.kind === 'movie') {
      const files = this.filesFor(eq(mediaFiles.mediaItemId, item.id));
      const file = (latest?.mediaFileId && files.find((f) => f.id === latest.mediaFileId)) || pickDefaultFile(files);
      if (!file) return null;
      const resume = !!latest && !latest.completed && latest.positionSeconds >= 30;
      return {
        fileId: file.id,
        episodeId: null,
        episodeLabel: null,
        episodeTitle: null,
        positionSeconds: resume ? latest!.positionSeconds : 0,
        durationSeconds: file.durationSeconds,
        resume,
      };
    }
    const eps = this.playableEpisodes(item.id);
    if (!eps.length) return null;
    if (latest?.episodeId) {
      const index = eps.findIndex((e) => e.id === latest.episodeId);
      if (index >= 0 && !latest.completed) return this.episodeTarget(eps[index]!, latest);
      if (index >= 0 && eps[index + 1]) return this.episodeTarget(eps[index + 1]!);
    }
    return this.episodeTarget(eps[0]!);
  }

  continueWatching(profile: Profile): CardDto[] {
    const since = new Date(Date.now() - RECENT_WINDOW_MS);
    const entries: Array<{ itemId: number; target: PlayTarget }> = [];
    for (const p of this.latestProgress(profile).values()) {
      if (p.hiddenFromContinue || p.lastWatchedAt < since || entries.length >= ROW_SIZE) continue;
      const inProgress = !p.completed && p.positionSeconds >= 30;
      if (!p.episodeId) {
        if (!inProgress) continue;
        const item = this.db.select().from(mediaItems).where(eq(mediaItems.id, p.mediaItemId)).get();
        const target = item && this.playTarget(profile, item);
        if (target) entries.push({ itemId: p.mediaItemId, target });
        continue;
      }
      const eps = this.playableEpisodes(p.mediaItemId);
      const index = eps.findIndex((e) => e.id === p.episodeId);
      const episode = inProgress ? eps[index] : index >= 0 ? eps[index + 1] : undefined;
      const target = episode && this.episodeTarget(episode, inProgress ? p : undefined);
      if (target) entries.push({ itemId: p.mediaItemId, target });
    }
    if (!entries.length) return [];
    const byId = new Map(this.visibleRows(profile, inArray(mediaItems.id, entries.map((e) => e.itemId))).map((r) => [r.id, r]));
    const visible = entries.filter((e) => byId.has(e.itemId));
    const cards = this.toCards(profile, visible.map((e) => byId.get(e.itemId)!));
    return cards.map((card, i) => {
      const target = visible[i]!.target;
      const progress = target.durationSeconds ? Math.min(1, target.positionSeconds / target.durationSeconds) : 0;
      return { ...card, target, progress };
    });
  }

  /** Records playback position. Returns whether the title now counts as watched. */
  saveProgress(profile: Profile, file: MediaFile, positionSeconds: number, durationSeconds?: number): { completed: boolean } {
    const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : file.durationSeconds;
    const completed = isComplete(positionSeconds, duration);
    return this.db.transaction((tx) => {
      const key = file.episodeId
        ? and(eq(watchProgress.profileId, profile.id), eq(watchProgress.episodeId, file.episodeId))
        : and(eq(watchProgress.profileId, profile.id), eq(watchProgress.mediaItemId, file.mediaItemId), sql`${watchProgress.episodeId} IS NULL`);
      const existing = tx.select().from(watchProgress).where(key).get();
      const values = {
        mediaFileId: file.id,
        positionSeconds: completed ? 0 : Math.max(0, positionSeconds),
        durationSeconds: duration ?? null,
        completed: completed || (!!existing?.completed && positionSeconds < 30),
        hiddenFromContinue: false,
        lastWatchedAt: new Date(),
      };
      const playCount = (existing?.playCount ?? 0) + (completed && !existing?.completed ? 1 : 0);
      if (existing) tx.update(watchProgress).set({ ...values, playCount }).where(eq(watchProgress.id, existing.id)).run();
      else tx.insert(watchProgress).values({ profileId: profile.id, mediaItemId: file.mediaItemId, episodeId: file.episodeId, ...values, playCount }).run();
      return { completed: values.completed };
    });
  }

  /** Mark a movie, a whole show, or one episode as watched/unwatched. */
  setWatched(profile: Profile, item: MediaItem, watched: boolean, episodeId?: number): void {
    const targets: Array<{ episodeId: number | null }> =
      item.kind === 'movie'
        ? [{ episodeId: null }]
        : episodeId
          ? [{ episodeId }]
          : this.playableEpisodes(item.id).map((e) => ({ episodeId: e.id }));
    this.db.transaction((tx) => {
      for (const t of targets) {
        const key = t.episodeId
          ? and(eq(watchProgress.profileId, profile.id), eq(watchProgress.episodeId, t.episodeId))
          : and(eq(watchProgress.profileId, profile.id), eq(watchProgress.mediaItemId, item.id), sql`${watchProgress.episodeId} IS NULL`);
        if (!watched) {
          tx.delete(watchProgress).where(key).run();
          continue;
        }
        const existing = tx.select().from(watchProgress).where(key).get();
        const values = { completed: true, positionSeconds: 0, lastWatchedAt: new Date(), hiddenFromContinue: false };
        if (existing) tx.update(watchProgress).set({ ...values, playCount: existing.completed ? existing.playCount : existing.playCount + 1 }).where(eq(watchProgress.id, existing.id)).run();
        else tx.insert(watchProgress).values({ profileId: profile.id, mediaItemId: item.id, episodeId: t.episodeId, ...values, playCount: 1 }).run();
      }
    });
  }

  hideFromContinue(profile: Profile, itemId: number): void {
    this.db
      .update(watchProgress)
      .set({ hiddenFromContinue: true })
      .where(and(eq(watchProgress.profileId, profile.id), eq(watchProgress.mediaItemId, itemId)))
      .run();
  }

  // ── details ────────────────────────────────────────────────────────────────

  /** The item if it exists, is on disk and the profile may see it. */
  findVisible(profile: Profile, itemId: number): MediaItem | undefined {
    const item = this.db.select().from(mediaItems).where(and(eq(mediaItems.id, itemId), available)).get();
    return item && canAccess(profile, item) ? item : undefined;
  }

  detail(profile: Profile, item: MediaItem) {
    const card = this.toCards(profile, [item as CardRow])[0]!;
    const library = this.db.select({ id: libraries.id, name: libraries.name, type: libraries.type }).from(libraries).where(eq(libraries.id, item.libraryId)).get();
    const files = item.kind === 'movie' ? this.filesFor(eq(mediaFiles.mediaItemId, item.id)) : [];
    const latest = item.kind === 'movie' ? this.latestProgress(profile, [item.id]).get(item.id) : undefined;

    let seasonList: Array<{ seasonNumber: number; title: string | null; poster: string | null; episodeCount: number; watchedCount: number }> = [];
    if (item.kind === 'show') {
      const eps = this.playableEpisodes(item.id);
      const watched = new Set(
        this.db
          .select({ episodeId: watchProgress.episodeId })
          .from(watchProgress)
          .where(and(eq(watchProgress.profileId, profile.id), eq(watchProgress.mediaItemId, item.id), eq(watchProgress.completed, true)))
          .all()
          .map((r) => r.episodeId),
      );
      const seasonRows = this.db.select().from(seasons).where(eq(seasons.showId, item.id)).all();
      seasonList = seasonRows
        .map((s) => {
          const inSeason = eps.filter((e) => e.seasonId === s.id);
          return {
            seasonNumber: s.seasonNumber,
            title: s.title ?? (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`),
            poster: artworkUrl('season', s.id, 'poster', s.poster),
            episodeCount: inSeason.length,
            watchedCount: inSeason.filter((e) => watched.has(e.id)).length,
          };
        })
        .filter((s) => s.episodeCount > 0)
        .sort((a, b) => (a.seasonNumber === 0 ? 1 : 0) - (b.seasonNumber === 0 ? 1 : 0) || a.seasonNumber - b.seasonNumber);
    }

    const similar = this.visibleRows(profile, and(eq(mediaItems.kind, item.kind), sql`${mediaItems.id} <> ${item.id}`))
      .map((r) => ({ r, overlap: r.genres.filter((g) => item.genres.includes(g)).length }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || (b.r.rating ?? 0) - (a.r.rating ?? 0))
      .slice(0, 12)
      .map((x) => x.r);

    return {
      ...card,
      overview: item.overview,
      tagline: item.tagline,
      originalTitle: item.originalTitle,
      releaseDate: item.releaseDate,
      studios: item.studios,
      status: item.status,
      cast: item.cast.slice(0, 30).map((c, i) => ({
        name: c.name,
        character: c.character ?? null,
        photo: artworkUrl('item', item.id, `cast-${i}`, c.photo),
      })),
      crew: item.crew
        .filter((c) => ['Director', 'Creator', 'Writer', 'Screenplay', 'Novel'].includes(c.job))
        .slice(0, 10)
        .map((c) => ({ name: c.name, job: c.job })),
      externalIds: item.externalIds,
      metadataSources: item.metadataSources,
      locked: item.locked,
      library: library ?? null,
      versions: files.map(toVersion),
      watched: item.kind === 'movie' ? !!latest?.completed : seasonList.length > 0 && seasonList.every((s) => s.watchedCount === s.episodeCount),
      target: this.playTarget(profile, item),
      seasons: seasonList,
      similar: this.toCards(profile, similar),
    };
  }

  season(profile: Profile, item: MediaItem, seasonNumber: number) {
    const eps = this.playableEpisodes(item.id).filter((e) => e.seasonNumber === seasonNumber);
    if (!eps.length) return null;
    const ids = eps.map((e) => e.id);
    const files = this.db.select().from(mediaFiles).where(and(inArray(mediaFiles.episodeId, ids), playable)).all();
    const progress = new Map(
      this.db
        .select()
        .from(watchProgress)
        .where(and(eq(watchProgress.profileId, profile.id), inArray(watchProgress.episodeId, ids)))
        .all()
        .map((p) => [p.episodeId!, p]),
    );
    return eps.map((e) => {
      const versions = files.filter((f) => f.episodeId === e.id);
      const p = progress.get(e.id);
      const file = (p?.mediaFileId && versions.find((v) => v.id === p.mediaFileId)) || pickDefaultFile(versions)!;
      const duration = file.durationSeconds ?? p?.durationSeconds ?? null;
      return {
        id: e.id,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        episodeNumberEnd: e.episodeNumberEnd,
        label: episodeLabel(e),
        title: e.title ?? `Episode ${e.episodeNumber}`,
        overview: e.overview,
        still: artworkUrl('episode', e.id, 'still', e.still),
        airDate: e.airDate,
        runtimeMinutes: e.runtimeMinutes ?? (duration ? Math.round(duration / 60) : null),
        fileId: file.id,
        versions: versions.map(toVersion),
        watched: !!p?.completed,
        positionSeconds: p && !p.completed ? p.positionSeconds : 0,
        progress: p && !p.completed && duration ? Math.min(1, p.positionSeconds / duration) : 0,
      };
    });
  }

  /** Everything the player needs about a file: titles, versions, resume point, next episode. */
  playerContext(profile: Profile, file: MediaFile) {
    const item = this.findVisible(profile, file.mediaItemId);
    if (!item) return null;
    const episode = file.episodeId ? this.db.select().from(episodes).where(eq(episodes.id, file.episodeId)).get() : undefined;
    const siblings = this.filesFor(episode ? eq(mediaFiles.episodeId, episode.id) : eq(mediaFiles.mediaItemId, item.id));
    const progressRow = this.db
      .select()
      .from(watchProgress)
      .where(
        episode
          ? and(eq(watchProgress.profileId, profile.id), eq(watchProgress.episodeId, episode.id))
          : and(eq(watchProgress.profileId, profile.id), eq(watchProgress.mediaItemId, item.id), sql`${watchProgress.episodeId} IS NULL`),
      )
      .get();

    let next: PlayTarget | null = null;
    if (episode) {
      const eps = this.playableEpisodes(item.id);
      const index = eps.findIndex((e) => e.id === episode.id);
      if (index >= 0 && eps[index + 1]) next = this.episodeTarget(eps[index + 1]!);
    }
    return {
      fileId: file.id,
      item: {
        id: item.id,
        kind: item.kind,
        title: item.title,
        year: item.year,
        logo: artworkUrl('item', item.id, 'logo', item.logo),
        backdrop: artworkUrl('item', item.id, 'backdrop', item.backdrop),
      },
      episode: episode
        ? { id: episode.id, label: episodeLabel(episode), title: episode.title ?? `Episode ${episode.episodeNumber}` }
        : null,
      durationSeconds: file.durationSeconds,
      resumeSeconds: progressRow && !progressRow.completed ? progressRow.positionSeconds : 0,
      versions: siblings.map(toVersion),
      next,
      preferences: profile.preferences,
    };
  }
}
