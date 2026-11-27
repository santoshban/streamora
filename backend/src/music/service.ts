import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  musicAlbums,
  musicArtists,
  musicLikes,
  musicPlays,
  musicTracks,
  playlists,
  playlistTracks,
  type MusicTrack,
  type Playlist,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { VARIOUS_ARTISTS } from './tags.js';

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface Ref {
  id: number;
  name: string;
}

export interface TrackDto {
  id: number;
  title: string;
  artist: Ref;
  /** Full credit as tagged ("A feat. B"). */
  artistName: string;
  album: { id: number; title: string };
  duration: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  art: string | null;
  /** MIME type with codecs, for `canPlayType`; null when no browser plays it. */
  mime: string | null;
  liked: boolean;
}

export interface AlbumDto {
  id: number;
  title: string;
  artist: Ref;
  year: number | null;
  art: string | null;
  genres: string[];
  trackCount: number;
  duration: number;
  /** Short releases are listed under "Singles & EPs" on artist pages. */
  kind: 'album' | 'single' | 'ep';
  single: boolean;
  addedAt: string;
}

export interface ArtistDto {
  id: number;
  name: string;
  art: string | null;
  albumCount: number;
  trackCount: number;
}

export interface PlaylistDto {
  id: number;
  name: string;
  description: string | null;
  trackCount: number;
  duration: number;
  /** Up to four album covers for the collage. */
  arts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MixDto {
  /** `supermix`, `discover`, `genre:<name>`, `artist:<id>`. */
  id: string;
  title: string;
  subtitle: string;
  arts: string[];
}

export type ListenAgainItem =
  | { type: 'album'; album: AlbumDto }
  | { type: 'artist'; artist: ArtistDto }
  | { type: 'playlist'; playlist: PlaylistDto };

// ── helpers ──────────────────────────────────────────────────────────────────

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

export const albumArtUrl = (albumId: number, cover: string | null | undefined) =>
  cover ? `/api/music/art/album/${albumId}?v=${hash(cover)}` : null;
export const artistArtUrl = (artistId: number, image: string) => `/api/music/art/artist/${artistId}?v=${hash(image)}`;
export const trackArtUrl = (trackId: number, version: string) => `/api/music/art/track/${trackId}?v=${hash(version)}`;

/** Container + codec → MIME type browsers understand (they decide with canPlayType). */
export function mimeFor(codec: string | null, container: string | null): string | null {
  const c = (codec ?? '').toLowerCase();
  switch (container) {
    case 'mp3':
      return c === 'mp3' ? 'audio/mpeg' : null;
    case 'flac':
      return c === 'flac' ? 'audio/flac' : null;
    case 'aac':
      return c === 'aac' ? 'audio/aac' : null;
    case 'wav':
      return c.startsWith('pcm_') ? 'audio/wav' : c === 'mp3' ? 'audio/mpeg' : null;
    case 'mp4':
      if (c === 'aac') return 'audio/mp4; codecs="mp4a.40.2"';
      if (c === 'alac') return 'audio/mp4; codecs="alac"';
      if (c === 'flac') return 'audio/mp4; codecs="flac"';
      if (c === 'mp3') return 'audio/mp4; codecs="mp4a.6B"';
      if (c === 'opus') return 'audio/mp4; codecs="opus"';
      return null;
    case 'ogg':
      return c === 'opus' || c === 'vorbis' || c === 'flac' ? `audio/ogg; codecs="${c}"` : null;
    case 'mka':
      return c === 'opus' || c === 'vorbis' ? `audio/webm; codecs="${c}"` : null;
    default:
      return null;
  }
}

/** Plain content type for a direct stream (no codecs parameter). */
export const contentTypeOf = (mime: string | null) => (mime ?? 'application/octet-stream').split(';')[0]!.trim();

// Drizzle leaves columns unqualified in join-less queries, which is ambiguous inside
// the raw sub-queries below: always name the table there.
const ARTIST_ID = sql.raw('"music_artists"."id"');
const ALBUM_ID = sql.raw('"music_albums"."id"');
const ALBUM_GENRES = sql.raw('"music_albums"."genres"');
const TRACK_ID = sql.raw('"music_tracks"."id"');
const TRACK_GENRES = sql.raw('"music_tracks"."genres"');

/** Tracks the UI can show: on disk, and readable (or not probed because ffprobe is missing). */
const VISIBLE = sql`(${musicTracks.missing} = 0 AND (${musicTracks.probeError} IS NULL OR ${musicTracks.probedAt} IS NULL))`;
/** Same condition on a `t` alias inside raw sub-queries. */
const VISIBLE_T = sql.raw(`(t.missing = 0 AND (t.probe_error IS NULL OR t.probed_at IS NULL))`);

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

function joinNames(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] ?? '';
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n.slice(0, 2).join(', ')} and more`;
}

const trackColumns = {
  id: musicTracks.id,
  title: musicTracks.title,
  artistName: musicTracks.artistName,
  artistId: musicTracks.artistId,
  artist: musicArtists.name,
  albumId: musicTracks.albumId,
  albumTitle: musicAlbums.title,
  cover: musicAlbums.cover,
  duration: musicTracks.durationSeconds,
  trackNumber: musicTracks.trackNumber,
  discNumber: musicTracks.discNumber,
  year: musicTracks.year,
  albumYear: musicAlbums.year,
  codec: musicTracks.codec,
  container: musicTracks.container,
  path: musicTracks.path,
  sizeBytes: musicTracks.sizeBytes,
  mtimeMs: musicTracks.mtimeMs,
  hasArt: musicTracks.hasEmbeddedArt,
};

type TrackRow = {
  id: number;
  title: string;
  artistName: string;
  artistId: number;
  artist: string;
  albumId: number;
  albumTitle: string;
  cover: string | null;
  duration: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  albumYear: number | null;
  codec: string | null;
  container: string | null;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  hasArt: boolean;
};

/** A song's own picture when it has one (downloads in one folder each carry their own), else its album's cover. */
const trackArtOf = (r: Pick<TrackRow, 'id' | 'albumId' | 'cover' | 'path' | 'sizeBytes' | 'mtimeMs' | 'hasArt'>) =>
  r.hasArt ? trackArtUrl(r.id, `${r.path}|${r.sizeBytes}|${r.mtimeMs}`) : albumArtUrl(r.albumId, r.cover);

const albumColumns = {
  id: musicAlbums.id,
  title: musicAlbums.title,
  artistId: musicAlbums.artistId,
  artist: musicArtists.name,
  year: musicAlbums.year,
  cover: musicAlbums.cover,
  genres: musicAlbums.genres,
  createdAt: musicAlbums.createdAt,
  trackCount: sql<number>`(SELECT count(*) FROM music_tracks t WHERE t.album_id = ${ALBUM_ID} AND ${VISIBLE_T})`,
  duration: sql<number>`(SELECT coalesce(sum(t.duration_seconds), 0) FROM music_tracks t WHERE t.album_id = ${ALBUM_ID} AND ${VISIBLE_T})`,
};

type AlbumRow = {
  id: number;
  title: string;
  artistId: number;
  artist: string;
  year: number | null;
  cover: string | null;
  genres: string[];
  createdAt: Date;
  trackCount: number;
  duration: number;
};

const ALBUM_HAS_TRACKS = sql`EXISTS (SELECT 1 FROM music_tracks t WHERE t.album_id = ${ALBUM_ID} AND ${VISIBLE_T})`;

const artistColumns = {
  id: musicArtists.id,
  name: musicArtists.name,
  image: musicArtists.image,
  albumCount: sql<number>`(SELECT count(*) FROM music_albums al WHERE al.artist_id = ${ARTIST_ID}
    AND EXISTS (SELECT 1 FROM music_tracks t WHERE t.album_id = al.id AND ${VISIBLE_T}))`,
  trackCount: sql<number>`(SELECT count(*) FROM music_tracks t WHERE (t.artist_id = ${ARTIST_ID}
    OR t.album_id IN (SELECT al.id FROM music_albums al WHERE al.artist_id = ${ARTIST_ID})) AND ${VISIBLE_T})`,
  // No artist photo: the newest album cover of theirs, or of an album they appear on.
  fallback: sql<string | null>`coalesce(
    (SELECT al.id || '|' || al.cover FROM music_albums al WHERE al.artist_id = ${ARTIST_ID} AND al.cover IS NOT NULL ORDER BY al.year DESC LIMIT 1),
    (SELECT al.id || '|' || al.cover FROM music_tracks t JOIN music_albums al ON al.id = t.album_id WHERE t.artist_id = ${ARTIST_ID} AND al.cover IS NOT NULL LIMIT 1))`,
};

type ArtistRow = {
  id: number;
  name: string;
  image: string | null;
  albumCount: number;
  trackCount: number;
  fallback: string | null;
};

const ARTIST_HAS_TRACKS = sql`EXISTS (SELECT 1 FROM music_tracks t WHERE (t.artist_id = ${ARTIST_ID}
  OR t.album_id IN (SELECT al.id FROM music_albums al WHERE al.artist_id = ${ARTIST_ID})) AND ${VISIBLE_T})`;

/** Track or album genres contain `genre` (case-insensitive). */
const hasGenre = (genre: string) => sql`(
  EXISTS (SELECT 1 FROM json_each(${TRACK_GENRES}) WHERE lower(json_each.value) = lower(${genre}))
  OR EXISTS (SELECT 1 FROM json_each(${ALBUM_GENRES}) WHERE lower(json_each.value) = lower(${genre})))`;

export type TrackSort = 'added' | 'title' | 'artist' | 'album' | 'plays';
export type AlbumSort = 'added' | 'title' | 'artist' | 'year' | 'recent';
export type ArtistSort = 'name' | 'added' | 'tracks';

// ── service ──────────────────────────────────────────────────────────────────

/** Read and write side of the music section, always for one signed-in profile. */
export class MusicService {
  constructor(private readonly db: DB) {}

  // ── DTO mapping ────────────────────────────────────────────────────────────

  private likedIds(profileId: number, trackIds?: number[]): Set<number> {
    if (trackIds && !trackIds.length) return new Set();
    const where = trackIds
      ? and(eq(musicLikes.profileId, profileId), inArray(musicLikes.trackId, trackIds.slice(0, 900)))
      : eq(musicLikes.profileId, profileId);
    return new Set(this.db.select({ id: musicLikes.trackId }).from(musicLikes).where(where).all().map((r) => r.id));
  }

  private toTracks(rows: TrackRow[], profileId: number): TrackDto[] {
    const liked = rows.length > 900 ? this.likedIds(profileId) : this.likedIds(profileId, rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      artist: { id: r.artistId, name: r.artist },
      artistName: r.artistName,
      album: { id: r.albumId, title: r.albumTitle },
      duration: r.duration,
      trackNumber: r.trackNumber,
      discNumber: r.discNumber,
      year: r.year ?? r.albumYear,
      art: trackArtOf(r),
      mime: mimeFor(r.codec, r.container),
      liked: liked.has(r.id),
    }));
  }

  private toAlbum(r: AlbumRow): AlbumDto {
    const compilation = r.artist === VARIOUS_ARTISTS;
    const kind: AlbumDto['kind'] =
      compilation || r.trackCount > 6 || r.duration >= 30 * 60
        ? 'album'
        : r.trackCount <= 2 || (r.trackCount === 3 && r.duration < 10 * 60)
          ? 'single'
          : 'ep';
    return {
      id: r.id,
      title: r.title,
      artist: { id: r.artistId, name: r.artist },
      year: r.year,
      art: albumArtUrl(r.id, r.cover),
      genres: r.genres,
      trackCount: r.trackCount,
      duration: Math.round(r.duration),
      kind,
      single: kind !== 'album',
      addedAt: r.createdAt.toISOString(),
    };
  }

  private toArtist(r: ArtistRow): ArtistDto {
    let art: string | null = null;
    if (r.image) art = artistArtUrl(r.id, r.image);
    else if (r.fallback) {
      const sep = r.fallback.indexOf('|');
      art = albumArtUrl(Number(r.fallback.slice(0, sep)), r.fallback.slice(sep + 1));
    }
    return { id: r.id, name: r.name, art, albumCount: r.albumCount, trackCount: r.trackCount };
  }

  // ── base queries ───────────────────────────────────────────────────────────

  private trackRows(where?: SQL, orderBy: SQL[] = [], limit = 500, offset = 0): TrackRow[] {
    return this.db
      .select(trackColumns)
      .from(musicTracks)
      .innerJoin(musicAlbums, eq(musicAlbums.id, musicTracks.albumId))
      .innerJoin(musicArtists, eq(musicArtists.id, musicTracks.artistId))
      .where(where ? and(VISIBLE, where) : VISIBLE)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)
      .all();
  }

  /** Tracks in the order of `ids` (duplicates and hidden tracks dropped). */
  private tracksByIds(ids: number[], profileId: number): TrackDto[] {
    if (!ids.length) return [];
    const rows = new Map<number, TrackRow>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const r of this.trackRows(inArray(musicTracks.id, ids.slice(i, i + 500)))) rows.set(r.id, r);
    }
    return this.toTracks(
      ids.map((id) => rows.get(id)).filter((r): r is TrackRow => !!r),
      profileId,
    );
  }

  private albumRows(where?: SQL, orderBy: SQL[] = [], limit = 100, offset = 0): AlbumRow[] {
    return this.db
      .select(albumColumns)
      .from(musicAlbums)
      .innerJoin(musicArtists, eq(musicArtists.id, musicAlbums.artistId))
      .where(where ? and(ALBUM_HAS_TRACKS, where) : ALBUM_HAS_TRACKS)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)
      .all() as AlbumRow[];
  }

  private artistRows(where?: SQL, orderBy: SQL[] = [], limit = 100, offset = 0): ArtistRow[] {
    return this.db
      .select(artistColumns)
      .from(musicArtists)
      .where(where ? and(ARTIST_HAS_TRACKS, where) : ARTIST_HAS_TRACKS)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)
      .all();
  }

  private albumsByIds(ids: number[]): AlbumDto[] {
    if (!ids.length) return [];
    const rows = new Map(this.albumRows(inArray(musicAlbums.id, ids.slice(0, 500)), [], 500).map((r) => [r.id, r]));
    return ids.map((id) => rows.get(id)).filter((r): r is AlbumRow => !!r).map((r) => this.toAlbum(r));
  }

  private artistsByIds(ids: number[]): ArtistDto[] {
    if (!ids.length) return [];
    const rows = new Map(this.artistRows(inArray(musicArtists.id, ids.slice(0, 500)), [], 500).map((r) => [r.id, r]));
    return ids.map((id) => rows.get(id)).filter((r): r is ArtistRow => !!r).map((r) => this.toArtist(r));
  }

  private countTracks(): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(musicTracks).where(VISIBLE).get()?.n ?? 0;
  }

  /** Artist ids by this profile's plays, most played first. */
  private topArtistIds(profileId: number, limit: number): number[] {
    return this.db
      .select({ id: musicTracks.artistId })
      .from(musicPlays)
      .innerJoin(musicTracks, eq(musicTracks.id, musicPlays.trackId))
      .where(and(eq(musicPlays.profileId, profileId), VISIBLE))
      .groupBy(musicTracks.artistId)
      .orderBy(desc(sql`sum(${musicPlays.playCount})`), desc(sql`max(${musicPlays.lastPlayedAt})`))
      .limit(limit)
      .all()
      .map((r) => r.id);
  }

  private random(where: SQL | undefined, limit: number): TrackRow[] {
    return this.trackRows(where, [sql`random()`], limit);
  }

  /** Genres across the library, most albums first. */
  genres(limit = 40): Array<{ name: string; count: number }> {
    const rows = this.db.all<{ name: string; count: number }>(sql`
      SELECT g.value AS name, count(DISTINCT al.id) AS count
      FROM music_albums al, json_each(al.genres) g
      WHERE EXISTS (SELECT 1 FROM music_tracks t WHERE t.album_id = al.id AND ${VISIBLE_T})
      GROUP BY lower(g.value)
      ORDER BY count DESC, name
      LIMIT ${limit}`);
    return rows;
  }

  // ── pages ──────────────────────────────────────────────────────────────────

  home(profileId: number) {
    const total = this.countTracks();
    if (!total) {
      return { empty: true, genres: [], quickPicks: [], listenAgain: [], mixes: [], recentlyAdded: [], favoriteArtists: [], albumsForYou: [] };
    }
    const quickPicks = this.quickPicks(profileId);
    const recentlyAdded = this.albumRows(undefined, [desc(musicAlbums.createdAt)], 18).map((r) => this.toAlbum(r));
    const favoriteIds = this.topArtistIds(profileId, 18);
    const favoriteArtists = favoriteIds.length
      ? this.artistsByIds(favoriteIds)
      : this.artistRows(sql`${musicArtists.name} <> ${VARIOUS_ARTISTS}`, [sql`random()`], 18).map((r) => this.toArtist(r));
    return {
      empty: false,
      genres: this.genres(14).map((g) => g.name),
      quickPicks,
      listenAgain: this.listenAgain(profileId),
      mixes: this.mixes(profileId),
      recentlyAdded,
      favoriteArtists,
      albumsForYou: this.albumRows(undefined, [sql`random()`], 18).map((r) => this.toAlbum(r)),
    };
  }

  /** Most played, more by favourite artists and something new, shuffled. */
  private quickPicks(profileId: number, genre?: string): TrackDto[] {
    const scope = genre ? hasGenre(genre) : undefined;
    const top = this.db
      .select({ id: musicPlays.trackId })
      .from(musicPlays)
      .innerJoin(musicTracks, eq(musicTracks.id, musicPlays.trackId))
      .innerJoin(musicAlbums, eq(musicAlbums.id, musicTracks.albumId))
      .where(and(eq(musicPlays.profileId, profileId), VISIBLE, scope))
      .orderBy(desc(musicPlays.playCount), desc(musicPlays.lastPlayedAt))
      .limit(8)
      .all()
      .map((r) => r.id);
    const artists = this.topArtistIds(profileId, 5);
    const fromArtists = artists.length ? this.random(and(inArray(musicTracks.artistId, artists), scope), 8).map((r) => r.id) : [];
    const fresh = this.random(scope, 24).map((r) => r.id);
    const ids = shuffle([...new Set([...top, ...fromArtists, ...fresh])]).slice(0, 20);
    return this.tracksByIds(ids, profileId);
  }

  private listenAgain(profileId: number): ListenAgainItem[] {
    const albums = this.db.all<{ albumId: number }>(sql`
      SELECT t.album_id AS albumId, max(p.last_played_at) AS at
      FROM music_plays p JOIN music_tracks t ON t.id = p.track_id
      WHERE p.profile_id = ${profileId} AND ${VISIBLE_T}
      GROUP BY t.album_id ORDER BY at DESC LIMIT 14`);
    const albumDtos = this.albumsByIds(albums.map((a) => a.albumId));
    const artists = this.artistsByIds(this.topArtistIds(profileId, 4).filter((id) => id));
    const items: ListenAgainItem[] = [];
    // Interleave a few artists among the albums, like the real shelf does.
    albumDtos.forEach((album, i) => {
      items.push({ type: 'album', album });
      if (i % 3 === 1 && artists.length) items.push({ type: 'artist', artist: artists.shift()! });
    });
    for (const artist of artists) items.push({ type: 'artist', artist });
    return items.slice(0, 16);
  }

  mixes(profileId: number): MixDto[] {
    const mixes: MixDto[] = [];
    const artsFor = (where?: SQL) =>
      this.albumRows(and(sql`${musicAlbums.cover} IS NOT NULL`, where), [sql`random()`], 4)
        .map((r) => albumArtUrl(r.id, r.cover))
        .filter((a): a is string => !!a);
    const namesFor = (where?: SQL) =>
      this.db
        .selectDistinct({ name: musicArtists.name })
        .from(musicTracks)
        .innerJoin(musicAlbums, eq(musicAlbums.id, musicTracks.albumId))
        .innerJoin(musicArtists, eq(musicArtists.id, musicTracks.artistId))
        .where(where ? and(VISIBLE, where) : VISIBLE)
        .orderBy(sql`random()`)
        .limit(3)
        .all()
        .map((r) => r.name);

    mixes.push({ id: 'supermix', title: 'My Supermix', subtitle: joinNames(namesFor()), arts: artsFor() });
    for (const g of this.genres(5)) {
      const where = hasGenre(g.name);
      mixes.push({ id: `genre:${g.name}`, title: `${g.name} Mix`, subtitle: joinNames(namesFor(where)), arts: artsFor(sql`EXISTS (SELECT 1 FROM json_each(${ALBUM_GENRES}) WHERE lower(json_each.value) = lower(${g.name}))`) });
    }
    for (const artist of this.artistsByIds(this.topArtistIds(profileId, 3))) {
      mixes.push({
        id: `artist:${artist.id}`,
        title: `${artist.name} Mix`,
        subtitle: joinNames([artist.name, ...this.relatedArtists(artist.id, 3).map((a) => a.name)]),
        arts: artist.art ? [artist.art] : [],
      });
    }
    mixes.push({ id: 'discover', title: 'Discover Mix', subtitle: 'Songs from your library you haven’t played yet', arts: artsFor() });
    return mixes;
  }

  /** The tracks of a mix, freshly shuffled every time. */
  mix(id: string, profileId: number): { mix: MixDto; tracks: TrackDto[] } {
    const mix = this.mixes(profileId).find((m) => m.id === id) ?? this.describeMix(id);
    let ids: number[];
    if (id === 'supermix') {
      const played = this.db
        .select({ id: musicPlays.trackId })
        .from(musicPlays)
        .where(eq(musicPlays.profileId, profileId))
        .orderBy(desc(musicPlays.playCount))
        .limit(30)
        .all()
        .map((r) => r.id);
      ids = shuffle([...new Set([...played, ...this.random(undefined, 50).map((r) => r.id)])]).slice(0, 50);
    } else if (id === 'discover') {
      ids = this.random(sql`NOT EXISTS (SELECT 1 FROM music_plays p WHERE p.track_id = ${TRACK_ID} AND p.profile_id = ${profileId})`, 50).map((r) => r.id);
    } else if (id.startsWith('genre:')) {
      ids = this.random(hasGenre(id.slice('genre:'.length)), 50).map((r) => r.id);
    } else if (id.startsWith('artist:')) {
      ids = this.radioIds({ artistId: Number(id.slice('artist:'.length)) }, profileId, [], 50);
    } else {
      throw notFound('Mix not found');
    }
    return { mix, tracks: this.tracksByIds(ids, profileId) };
  }

  private describeMix(id: string): MixDto {
    if (id.startsWith('genre:')) return { id, title: `${id.slice(6)} Mix`, subtitle: '', arts: [] };
    if (id.startsWith('artist:')) {
      const artist = this.artistsByIds([Number(id.slice(7))])[0];
      if (!artist) throw notFound('Mix not found');
      return { id, title: `${artist.name} Mix`, subtitle: '', arts: artist.art ? [artist.art] : [] };
    }
    throw notFound('Mix not found');
  }

  explore(profileId: number) {
    const top = this.db.all<{ id: number }>(sql`
      SELECT p.track_id AS id FROM music_plays p JOIN music_tracks t ON t.id = p.track_id
      WHERE ${VISIBLE_T} GROUP BY p.track_id ORDER BY sum(p.play_count) DESC LIMIT 20`);
    const topIds = top.map((r) => r.id);
    if (topIds.length < 20) topIds.push(...this.random(undefined, 30).map((r) => r.id).filter((id) => !topIds.includes(id)));
    return {
      genres: this.genres(32),
      newAlbums: this.albumRows(undefined, [desc(musicAlbums.createdAt)], 18).map((r) => this.toAlbum(r)),
      topSongs: this.tracksByIds(topIds.slice(0, 20), profileId),
      artists: this.artistRows(sql`${musicArtists.name} <> ${VARIOUS_ARTISTS}`, [sql`random()`], 18).map((r) => this.toArtist(r)),
    };
  }

  genre(name: string, profileId: number) {
    const albumWhere = sql`EXISTS (SELECT 1 FROM json_each(${ALBUM_GENRES}) WHERE lower(json_each.value) = lower(${name}))`;
    const albums = this.albumRows(albumWhere, [desc(musicAlbums.year)], 60).map((r) => this.toAlbum(r));
    const tracks = this.toTracks(this.random(hasGenre(name), 30), profileId);
    if (!albums.length && !tracks.length) throw notFound('Genre not found');
    return { name, albums, tracks };
  }

  // ── library lists ──────────────────────────────────────────────────────────

  tracks(profileId: number, q: { sort?: TrackSort; order?: 'asc' | 'desc'; offset: number; limit: number }) {
    const dir = (q.order ?? (q.sort === 'added' || q.sort === 'plays' || !q.sort ? 'desc' : 'asc')) === 'asc' ? asc : desc;
    const playCount = sql`coalesce((SELECT p.play_count FROM music_plays p WHERE p.track_id = ${TRACK_ID} AND p.profile_id = ${profileId}), 0)`;
    const order: Record<TrackSort, SQL[]> = {
      added: [dir(musicTracks.createdAt), asc(musicTracks.id)],
      title: [dir(musicTracks.sortTitle)],
      artist: [dir(musicArtists.sortName), asc(musicAlbums.sortTitle), asc(musicTracks.discNumber), asc(musicTracks.trackNumber)],
      album: [dir(musicAlbums.sortTitle), asc(musicTracks.discNumber), asc(musicTracks.trackNumber)],
      plays: [dir(playCount), asc(musicTracks.sortTitle)],
    };
    const rows = this.trackRows(undefined, order[q.sort ?? 'added'], q.limit, q.offset);
    return { tracks: this.toTracks(rows, profileId), total: this.countTracks() };
  }

  albums(q: { sort?: AlbumSort; genre?: string; offset: number; limit: number; profileId: number }) {
    const where = q.genre
      ? sql`EXISTS (SELECT 1 FROM json_each(${ALBUM_GENRES}) WHERE lower(json_each.value) = lower(${q.genre}))`
      : undefined;
    const lastPlayed = sql`(SELECT max(p.last_played_at) FROM music_plays p JOIN music_tracks t ON t.id = p.track_id
      WHERE t.album_id = ${ALBUM_ID} AND p.profile_id = ${q.profileId})`;
    const order: Record<AlbumSort, SQL[]> = {
      added: [desc(musicAlbums.createdAt)],
      title: [asc(musicAlbums.sortTitle)],
      artist: [asc(musicArtists.sortName), desc(musicAlbums.year)],
      year: [desc(musicAlbums.year), asc(musicAlbums.sortTitle)],
      recent: [sql`${lastPlayed} IS NULL`, desc(lastPlayed), desc(musicAlbums.createdAt)],
    };
    const albums = this.albumRows(where, order[q.sort ?? 'added'], q.limit, q.offset).map((r) => this.toAlbum(r));
    const total =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(musicAlbums)
        .where(where ? and(ALBUM_HAS_TRACKS, where) : ALBUM_HAS_TRACKS)
        .get()?.n ?? 0;
    return { albums, total };
  }

  artists(q: { sort?: ArtistSort; offset: number; limit: number }) {
    const order: Record<ArtistSort, SQL[]> = {
      name: [asc(musicArtists.sortName)],
      added: [desc(musicArtists.createdAt)],
      tracks: [desc(artistColumns.trackCount), asc(musicArtists.sortName)],
    };
    const artists = this.artistRows(undefined, order[q.sort ?? 'name'], q.limit, q.offset).map((r) => this.toArtist(r));
    const total = this.db.select({ n: sql<number>`count(*)` }).from(musicArtists).where(ARTIST_HAS_TRACKS).get()?.n ?? 0;
    return { artists, total };
  }

  // ── details ────────────────────────────────────────────────────────────────

  album(id: number, profileId: number) {
    const row = this.albumRows(eq(musicAlbums.id, id), [], 1)[0];
    if (!row) throw notFound('Album not found');
    const tracks = this.toTracks(
      this.trackRows(eq(musicTracks.albumId, id), [
        sql`coalesce(${musicTracks.discNumber}, 1)`,
        sql`${musicTracks.trackNumber} IS NULL`,
        asc(musicTracks.trackNumber),
        asc(musicTracks.sortTitle),
      ]),
      profileId,
    );
    const more = this.albumRows(and(eq(musicAlbums.artistId, row.artistId), sql`${ALBUM_ID} <> ${id}`), [desc(musicAlbums.year)], 18)
      .map((r) => this.toAlbum(r));
    return { album: this.toAlbum(row), tracks, moreByArtist: row.artist === VARIOUS_ARTISTS ? [] : more };
  }

  artist(id: number, profileId: number) {
    const row = this.artistRows(eq(musicArtists.id, id), [], 1)[0];
    if (!row) throw notFound('Artist not found');
    const plays = sql`coalesce((SELECT sum(p.play_count) FROM music_plays p WHERE p.track_id = ${TRACK_ID}), 0)`;
    const mine = sql`coalesce((SELECT p.play_count FROM music_plays p WHERE p.track_id = ${TRACK_ID} AND p.profile_id = ${profileId}), 0)`;
    const byArtist = sql`(${musicTracks.artistId} = ${id} OR ${musicAlbums.artistId} = ${id})`;
    const topSongs = this.toTracks(
      this.trackRows(byArtist, [desc(mine), desc(plays), desc(musicAlbums.year), asc(musicTracks.trackNumber)], 10),
      profileId,
    );
    const own = this.albumRows(eq(musicAlbums.artistId, id), [desc(musicAlbums.year), asc(musicAlbums.sortTitle)], 200).map((r) => this.toAlbum(r));
    const appearsOn = this.albumRows(
      and(
        sql`${musicAlbums.artistId} <> ${id}`,
        sql`EXISTS (SELECT 1 FROM music_tracks t WHERE t.album_id = ${ALBUM_ID} AND t.artist_id = ${id} AND ${VISIBLE_T})`,
      ),
      [desc(musicAlbums.year)],
      30,
    ).map((r) => this.toAlbum(r));
    return {
      artist: this.toArtist(row),
      topSongs,
      albums: own.filter((a) => !a.single),
      singles: own.filter((a) => a.single),
      appearsOn,
      related: this.relatedArtists(id, 12),
    };
  }

  /** Every song by an artist (their own releases and features), newest release first. */
  artistTracks(id: number, profileId: number): TrackDto[] {
    return this.toTracks(
      this.trackRows(
        sql`(${musicTracks.artistId} = ${id} OR ${musicAlbums.artistId} = ${id})`,
        [desc(musicAlbums.year), asc(musicAlbums.sortTitle), sql`coalesce(${musicTracks.discNumber}, 1)`, asc(musicTracks.trackNumber)],
        2000,
      ),
      profileId,
    );
  }

  /** Artists sharing the most genres with this one. */
  private relatedArtists(artistId: number, limit: number): ArtistDto[] {
    const ids = this.db.all<{ id: number }>(sql`
      WITH mine AS (
        SELECT DISTINCT lower(g.value) AS genre FROM music_albums al, json_each(al.genres) g WHERE al.artist_id = ${artistId}
      )
      SELECT al.artist_id AS id, count(*) AS shared
      FROM music_albums al, json_each(al.genres) g
      JOIN music_artists a ON a.id = al.artist_id
      WHERE al.artist_id <> ${artistId} AND a.name <> ${VARIOUS_ARTISTS} AND lower(g.value) IN (SELECT genre FROM mine)
      GROUP BY al.artist_id ORDER BY shared DESC, random() LIMIT ${limit}`);
    return this.artistsByIds(ids.map((r) => r.id));
  }

  /** "Related" tab: more from the artist, then from related artists. */
  related(trackId: number, profileId: number) {
    const track = this.db.select().from(musicTracks).where(eq(musicTracks.id, trackId)).get();
    if (!track) throw notFound('Track not found');
    const radio = this.radioIds({ trackId }, profileId, [trackId], 20);
    return {
      tracks: this.tracksByIds(radio, profileId),
      artists: this.relatedArtists(track.artistId, 10),
      albums: this.albumRows(and(eq(musicAlbums.artistId, track.artistId), sql`${ALBUM_ID} <> ${track.albumId}`), [desc(musicAlbums.year)], 10)
        .map((r) => this.toAlbum(r)),
    };
  }

  // ── radio ──────────────────────────────────────────────────────────────────

  /** A station from a seed: some of the artist, the rest from the same genres. */
  private radioIds(seed: { trackId?: number; albumId?: number; artistId?: number }, profileId: number, exclude: number[], limit: number): number[] {
    let artistId = seed.artistId;
    let genres: string[] = [];
    let seedTrack: MusicTrack | undefined;
    if (seed.trackId) {
      seedTrack = this.db.select().from(musicTracks).where(eq(musicTracks.id, seed.trackId)).get();
      if (!seedTrack) throw notFound('Track not found');
      artistId = seedTrack.artistId;
      genres = seedTrack.genres;
    }
    if (seed.albumId) {
      const album = this.db.select().from(musicAlbums).where(eq(musicAlbums.id, seed.albumId)).get();
      if (!album) throw notFound('Album not found');
      artistId = album.artistId;
      genres = album.genres;
    }
    if (artistId && !genres.length) {
      genres = this.db
        .all<{ g: string }>(sql`SELECT DISTINCT g.value AS g FROM music_albums al, json_each(al.genres) g WHERE al.artist_id = ${artistId} LIMIT 5`)
        .map((r) => r.g);
    }
    const skip = exclude.length ? sql`${TRACK_ID} NOT IN (${sql.join(exclude.slice(0, 500).map((id) => sql`${id}`), sql`, `)})` : undefined;
    const byArtist = artistId
      ? this.random(and(sql`(${musicTracks.artistId} = ${artistId} OR ${musicAlbums.artistId} = ${artistId})`, skip), Math.ceil(limit * 0.4))
      : [];
    const genreScope = genres.length ? sql`(${sql.join(genres.map((g) => hasGenre(g)), sql` OR `)})` : undefined;
    const similar = this.random(and(genreScope, skip, artistId ? sql`${musicTracks.artistId} <> ${artistId}` : undefined), limit);
    const filler = similar.length + byArtist.length < limit ? this.random(skip, limit) : [];
    // Mostly alternate artist / similar so the station doesn't play one artist in a row.
    const mixed: number[] = [];
    const a = byArtist.map((r) => r.id);
    const s = [...similar, ...filler].map((r) => r.id);
    while (a.length || s.length) {
      if (s.length) mixed.push(s.shift()!);
      if (a.length && mixed.length % 2 === 1) mixed.push(a.shift()!);
      if (!s.length && a.length) mixed.push(a.shift()!);
    }
    const ids = [...new Set(mixed)].filter((id) => id !== seed.trackId);
    return (seedTrack && !exclude.includes(seedTrack.id) ? [seedTrack.id, ...ids] : ids).slice(0, limit);
  }

  radio(seed: { trackId?: number; albumId?: number; artistId?: number }, profileId: number, exclude: number[], limit = 25): TrackDto[] {
    return this.tracksByIds(this.radioIds(seed, profileId, exclude, limit), profileId);
  }

  // ── search ─────────────────────────────────────────────────────────────────

  search(query: string, profileId: number) {
    const q = query.trim().toLowerCase();
    const pattern = `%${escapeLike(q)}%`;
    const prefix = `${escapeLike(q)}%`;
    const like = (col: SQL) => sql`lower(${col}) LIKE ${pattern} ESCAPE '\\'`;
    const starts = (col: SQL) => sql`lower(${col}) LIKE ${prefix} ESCAPE '\\'`;

    const artists = this.artistRows(like(sql`${musicArtists.name}`), [desc(starts(sql`${musicArtists.name}`)), asc(musicArtists.sortName)], 12)
      .map((r) => this.toArtist(r));
    const albums = this.albumRows(
      sql`(${like(sql`${musicAlbums.title}`)} OR ${like(sql`${musicArtists.name}`)})`,
      [desc(starts(sql`${musicAlbums.title}`)), desc(musicAlbums.year)],
      12,
    ).map((r) => this.toAlbum(r));
    const songs = this.toTracks(
      this.trackRows(
        sql`(${like(sql`${musicTracks.title}`)} OR ${like(sql`${musicTracks.artistName}`)} OR ${like(sql`${musicAlbums.title}`)})`,
        [desc(starts(sql`${musicTracks.title}`)), desc(like(sql`${musicTracks.title}`)), asc(musicTracks.sortTitle)],
        30,
      ),
      profileId,
    );
    const lists = this.playlists(profileId).filter((p) => p.name.toLowerCase().includes(q));

    const exact = (name: string) => name.toLowerCase() === q;
    let top: { type: 'artist'; artist: ArtistDto } | { type: 'album'; album: AlbumDto } | { type: 'song'; track: TrackDto } | null = null;
    const artist = artists.find((a) => exact(a.name)) ?? artists.find((a) => a.name.toLowerCase().startsWith(q));
    const album = albums.find((a) => exact(a.title));
    const song = songs.find((s) => exact(s.title)) ?? songs[0];
    if (artist) top = { type: 'artist', artist };
    else if (album) top = { type: 'album', album };
    else if (song) top = { type: 'song', track: song };
    else if (albums[0]) top = { type: 'album', album: albums[0] };
    return { top, songs, albums, artists, playlists: lists };
  }

  /** Short list for the search box drop-down. */
  suggest(query: string): string[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const prefix = `${escapeLike(q)}%`;
    const word = `% ${escapeLike(q)}%`;
    const rows = this.db.all<{ s: string }>(sql`
      SELECT s FROM (
        SELECT name AS s, 1 AS w FROM music_artists WHERE lower(name) LIKE ${prefix} ESCAPE '\\' OR lower(name) LIKE ${word} ESCAPE '\\'
        UNION ALL SELECT title, 2 FROM music_albums WHERE lower(title) LIKE ${prefix} ESCAPE '\\'
        UNION ALL SELECT title, 3 FROM music_tracks t WHERE (lower(title) LIKE ${prefix} ESCAPE '\\' OR lower(title) LIKE ${word} ESCAPE '\\') AND ${VISIBLE_T}
      ) GROUP BY lower(s) ORDER BY min(w), length(s) LIMIT 8`);
    return rows.map((r) => r.s);
  }

  // ── likes & plays ──────────────────────────────────────────────────────────

  private requireTrack(trackId: number): MusicTrack {
    const track = this.db.select().from(musicTracks).where(eq(musicTracks.id, trackId)).get();
    if (!track) throw notFound('Track not found');
    return track;
  }

  setLiked(profileId: number, trackId: number, liked: boolean): void {
    this.requireTrack(trackId);
    if (liked) this.db.insert(musicLikes).values({ profileId, trackId }).onConflictDoNothing().run();
    else this.db.delete(musicLikes).where(and(eq(musicLikes.profileId, profileId), eq(musicLikes.trackId, trackId))).run();
  }

  liked(profileId: number) {
    const ids = this.db
      .select({ id: musicLikes.trackId })
      .from(musicLikes)
      .where(eq(musicLikes.profileId, profileId))
      .orderBy(desc(musicLikes.likedAt))
      .all()
      .map((r) => r.id);
    const tracks = this.tracksByIds(ids, profileId);
    return { tracks, duration: Math.round(tracks.reduce((s, t) => s + (t.duration ?? 0), 0)) };
  }

  recordPlay(profileId: number, trackId: number): void {
    this.requireTrack(trackId);
    this.db
      .insert(musicPlays)
      .values({ profileId, trackId, playCount: 1, lastPlayedAt: new Date() })
      .onConflictDoUpdate({
        target: [musicPlays.profileId, musicPlays.trackId],
        set: { playCount: sql`${musicPlays.playCount} + 1`, lastPlayedAt: new Date() },
      })
      .run();
  }

  history(profileId: number, limit = 100): TrackDto[] {
    const ids = this.db
      .select({ id: musicPlays.trackId })
      .from(musicPlays)
      .where(eq(musicPlays.profileId, profileId))
      .orderBy(desc(musicPlays.lastPlayedAt))
      .limit(limit)
      .all()
      .map((r) => r.id);
    return this.tracksByIds(ids, profileId);
  }

  // ── playlists ──────────────────────────────────────────────────────────────

  private ownPlaylist(profileId: number, id: number): Playlist {
    const list = this.db.select().from(playlists).where(and(eq(playlists.id, id), eq(playlists.profileId, profileId))).get();
    if (!list) throw notFound('Playlist not found');
    return list;
  }

  private playlistDtos(rows: Playlist[]): PlaylistDto[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const stats = new Map(
      this.db
        .all<{ id: number; n: number; d: number }>(sql`
          SELECT pt.playlist_id AS id, count(*) AS n, coalesce(sum(t.duration_seconds), 0) AS d
          FROM playlist_tracks pt JOIN music_tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND ${VISIBLE_T}
          GROUP BY pt.playlist_id`)
        .map((r) => [r.id, r]),
    );
    // The collage: the first four different pictures among the first songs.
    const firstTracks = this.db.all<{ playlistId: number; id: number; albumId: number; cover: string | null; path: string; sizeBytes: number; mtimeMs: number; hasArt: number }>(sql`
      SELECT playlistId, id, albumId, cover, path, sizeBytes, mtimeMs, hasArt FROM (
        SELECT pt.playlist_id AS playlistId, t.id AS id, al.id AS albumId, al.cover AS cover, t.path AS path,
          t.size_bytes AS sizeBytes, t.mtime_ms AS mtimeMs, t.has_embedded_art AS hasArt,
          row_number() OVER (PARTITION BY pt.playlist_id ORDER BY pt.position) AS n
        FROM playlist_tracks pt JOIN music_tracks t ON t.id = pt.track_id JOIN music_albums al ON al.id = t.album_id
        WHERE pt.playlist_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND (t.has_embedded_art = 1 OR al.cover IS NOT NULL) AND ${VISIBLE_T})
      WHERE n <= 40 ORDER BY playlistId, n`);
    const arts = new Map<number, string[]>();
    for (const t of firstTracks) {
      const list = arts.get(t.playlistId) ?? [];
      // Songs of an album that only has a folder cover all share it: show it once.
      const art = trackArtOf({ ...t, hasArt: !!t.hasArt });
      if (art && list.length < 4 && !list.includes(art)) list.push(art);
      arts.set(t.playlistId, list);
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      trackCount: stats.get(r.id)?.n ?? 0,
      duration: Math.round(stats.get(r.id)?.d ?? 0),
      arts: arts.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  playlists(profileId: number): PlaylistDto[] {
    return this.playlistDtos(
      this.db.select().from(playlists).where(eq(playlists.profileId, profileId)).orderBy(desc(playlists.updatedAt)).all(),
    );
  }

  playlist(profileId: number, id: number) {
    const list = this.ownPlaylist(profileId, id);
    const entries = this.db
      .select({ entryId: playlistTracks.id, trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, id))
      .orderBy(asc(playlistTracks.position), asc(playlistTracks.id))
      .all();
    const tracks = new Map(this.tracksByIds([...new Set(entries.map((e) => e.trackId))], profileId).map((t) => [t.id, t]));
    return {
      playlist: this.playlistDtos([list])[0]!,
      entries: entries.filter((e) => tracks.has(e.trackId)).map((e) => ({ entryId: e.entryId, track: tracks.get(e.trackId)! })),
    };
  }

  createPlaylist(profileId: number, body: { name: string; description?: string | null; trackIds?: number[] }): PlaylistDto {
    const created = this.db
      .insert(playlists)
      .values({ profileId, name: body.name, description: body.description ?? null })
      .returning()
      .get();
    if (body.trackIds?.length) this.addToPlaylist(profileId, created.id, body.trackIds);
    return this.playlistDtos([this.ownPlaylist(profileId, created.id)])[0]!;
  }

  updatePlaylist(profileId: number, id: number, body: { name?: string; description?: string | null }): PlaylistDto {
    this.ownPlaylist(profileId, id);
    this.db
      .update(playlists)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      })
      .where(eq(playlists.id, id))
      .run();
    return this.playlistDtos([this.ownPlaylist(profileId, id)])[0]!;
  }

  deletePlaylist(profileId: number, id: number): void {
    this.ownPlaylist(profileId, id);
    this.db.delete(playlists).where(eq(playlists.id, id)).run();
  }

  /** Appends tracks; returns how many were added and how many were already there. */
  addToPlaylist(profileId: number, id: number, trackIds: number[]): { added: number; duplicates: number } {
    this.ownPlaylist(profileId, id);
    const known = new Set(
      this.db
        .select({ id: musicTracks.id })
        .from(musicTracks)
        .where(inArray(musicTracks.id, trackIds.slice(0, 1000)))
        .all()
        .map((r) => r.id),
    );
    const valid = trackIds.filter((t) => known.has(t));
    if (!valid.length) throw badRequest('No such tracks');
    const already = new Set(
      this.db
        .select({ id: playlistTracks.trackId })
        .from(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, id), inArray(playlistTracks.trackId, valid)))
        .all()
        .map((r) => r.id),
    );
    this.db.transaction((tx) => {
      const max = tx.select({ m: sql<number | null>`max(${playlistTracks.position})` }).from(playlistTracks).where(eq(playlistTracks.playlistId, id)).get()?.m ?? -1;
      valid.forEach((trackId, i) => tx.insert(playlistTracks).values({ playlistId: id, trackId, position: max + 1 + i }).run());
      tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run();
    });
    return { added: valid.length, duplicates: valid.filter((t) => already.has(t)).length };
  }

  removeFromPlaylist(profileId: number, id: number, entryId: number): void {
    this.ownPlaylist(profileId, id);
    const res = this.db.delete(playlistTracks).where(and(eq(playlistTracks.id, entryId), eq(playlistTracks.playlistId, id))).run();
    if (!res.changes) throw notFound('Playlist entry not found');
    this.db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run();
  }

  /** Re-orders entries; `entryIds` must list every entry of the playlist. */
  reorderPlaylist(profileId: number, id: number, entryIds: number[]): void {
    this.ownPlaylist(profileId, id);
    const current = this.db.select({ id: playlistTracks.id }).from(playlistTracks).where(eq(playlistTracks.playlistId, id)).all();
    const ids = new Set(current.map((r) => r.id));
    if (entryIds.length !== ids.size || entryIds.some((e) => !ids.has(e)) || new Set(entryIds).size !== entryIds.length) {
      throw badRequest('entryIds must list every entry of the playlist once');
    }
    this.db.transaction((tx) => {
      entryIds.forEach((entryId, position) => tx.update(playlistTracks).set({ position }).where(eq(playlistTracks.id, entryId)).run());
      tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run();
    });
  }

  // ── files ──────────────────────────────────────────────────────────────────

  track(id: number): MusicTrack {
    return this.requireTrack(id);
  }

  /** The picture inside the song's file, or its album's cover once it has none. */
  trackArt(id: number): string | null {
    const row = this.db
      .select({ path: musicTracks.path, hasArt: musicTracks.hasEmbeddedArt, cover: musicAlbums.cover })
      .from(musicTracks)
      .innerJoin(musicAlbums, eq(musicAlbums.id, musicTracks.albumId))
      .where(eq(musicTracks.id, id))
      .get();
    if (!row) return null;
    return row.hasArt ? `embedded:${row.path}` : row.cover;
  }

  albumCover(id: number): string | null {
    return this.db.select({ cover: musicAlbums.cover }).from(musicAlbums).where(eq(musicAlbums.id, id)).get()?.cover ?? null;
  }

  artistImage(id: number): string | null {
    return this.db.select({ image: musicArtists.image }).from(musicArtists).where(eq(musicArtists.id, id)).get()?.image ?? null;
  }

  /** Counts per music library for the admin page. */
  libraryCounts(): Map<number, { albums: number; tracks: number; artists: number }> {
    const rows = this.db.all<{ id: number; albums: number; tracks: number; artists: number }>(sql`
      SELECT l.id AS id,
        (SELECT count(DISTINCT t.album_id) FROM music_tracks t WHERE t.library_id = l.id AND ${VISIBLE_T}) AS albums,
        (SELECT count(*) FROM music_tracks t WHERE t.library_id = l.id AND ${VISIBLE_T}) AS tracks,
        (SELECT count(DISTINCT t.artist_id) FROM music_tracks t WHERE t.library_id = l.id AND ${VISIBLE_T}) AS artists
      FROM libraries l WHERE l.type = 'music'`);
    return new Map(rows.map((r) => [r.id, { albums: r.albums, tracks: r.tracks, artists: r.artists }]));
  }
}
