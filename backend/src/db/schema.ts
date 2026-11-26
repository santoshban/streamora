import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  CastMember,
  CrewMember,
  ExternalIds,
  LibraryType,
  MediaKind,
  MediaStreamInfo,
  SettingValue,
  SubtitleSource,
} from '@streamora/plugin-sdk';
import type { ParsedName } from '../media/parse.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const now = sql`(unixepoch() * 1000)`;

const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now);
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(now)
    .$onUpdate(() => new Date());

const jsonArray = <T>(name: string) =>
  text(name, { mode: 'json' })
    .$type<T[]>()
    .notNull()
    .default(sql`'[]'`);

const jsonObject = <T>(name: string) =>
  text(name, { mode: 'json' })
    .$type<T>()
    .notNull()
    .default(sql`'{}'`);

export interface ProfilePreferences {
  audioLanguage?: string;
  subtitleLanguage?: string | null;
  subtitleStyle?: { size?: 'small' | 'medium' | 'large'; background?: 'none' | 'shadow' | 'box' };
  autoplayNext?: boolean;
  autoplayPreviews?: boolean;
}

/** Output of the filename parser, kept for debugging and re-matching. */
export type ParsedFileName = ParsedName;

// ── profiles ─────────────────────────────────────────────────────────────────

export const profiles = sqliteTable('profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** Avatar key understood by the UI (colour/illustration id). */
  avatar: text('avatar').notNull().default('crimson'),
  isKids: integer('is_kids', { mode: 'boolean' }).notNull().default(false),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  /** scrypt hash of the optional 4–8 digit profile PIN. */
  pinHash: text('pin_hash'),
  preferences: jsonObject<ProfilePreferences>('preferences'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── libraries ────────────────────────────────────────────────────────────────

export const libraries = sqliteTable('libraries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').$type<LibraryType>().notNull(),
  /** Absolute folder paths scanned for this library. */
  paths: jsonArray<string>('paths'),
  /** BCP 47 metadata language, e.g. `en-US`. */
  language: text('language').notNull().default('en-US'),
  /** Watch folders with chokidar and rescan incrementally. */
  watch: integer('watch', { mode: 'boolean' }).notNull().default(true),
  /** Ordered metadata plugin ids. `null` → all enabled metadata plugins by priority. */
  agents: text('agents', { mode: 'json' }).$type<string[] | null>(),
  lastScannedAt: integer('last_scanned_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── media_items: movies and shows ────────────────────────────────────────────

export const mediaItems = sqliteTable(
  'media_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<MediaKind>().notNull(),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    originalTitle: text('original_title'),
    year: integer('year'),
    releaseDate: text('release_date'),
    tagline: text('tagline'),
    overview: text('overview'),
    genres: jsonArray<string>('genres'),
    studios: jsonArray<string>('studios'),
    contentRating: text('content_rating'),
    rating: real('rating'),
    runtimeMinutes: integer('runtime_minutes'),
    status: text('status'),
    cast: jsonArray<CastMember>('cast'),
    crew: jsonArray<CrewMember>('crew'),
    poster: text('poster'),
    backdrop: text('backdrop'),
    logo: text('logo'),
    thumb: text('thumb'),
    externalIds: jsonObject<ExternalIds>('external_ids'),
    /**
     * Normalised identity used to group versions (e.g. 1080p + 4K files of the
     * same movie): `the matrix|1999`. Unique per library and kind.
     */
    matchKey: text('match_key').notNull(),
    /** Movie folder, or show root folder. */
    folderPath: text('folder_path'),
    /** When true, automatic refreshes keep the user's manual match/edits. */
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    /** Plugin ids that contributed metadata, in priority order. */
    metadataSources: jsonArray<string>('metadata_sources'),
    metadataUpdatedAt: integer('metadata_updated_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('media_items_identity_uq').on(t.libraryId, t.kind, t.matchKey),
    index('media_items_kind_idx').on(t.kind),
    index('media_items_sort_title_idx').on(t.sortTitle),
    index('media_items_created_idx').on(t.createdAt),
  ],
);

// ── seasons & episodes ───────────────────────────────────────────────────────

export const seasons = sqliteTable(
  'seasons',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    showId: integer('show_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    title: text('title'),
    overview: text('overview'),
    poster: text('poster'),
    airDate: text('air_date'),
    externalIds: jsonObject<ExternalIds>('external_ids'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('seasons_show_number_uq').on(t.showId, t.seasonNumber)],
);

export const episodes = sqliteTable(
  'episodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    showId: integer('show_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    seasonId: integer('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    episodeNumber: integer('episode_number').notNull(),
    /** Last episode covered by a multi-episode file (`S01E01-E02`). */
    episodeNumberEnd: integer('episode_number_end'),
    /** Absolute numbering, common for anime. */
    absoluteNumber: integer('absolute_number'),
    title: text('title'),
    overview: text('overview'),
    still: text('still'),
    airDate: text('air_date'),
    runtimeMinutes: integer('runtime_minutes'),
    rating: real('rating'),
    externalIds: jsonObject<ExternalIds>('external_ids'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('episodes_show_se_uq').on(t.showId, t.seasonNumber, t.episodeNumber),
    index('episodes_season_idx').on(t.seasonId),
  ],
);

// ── media_files: one row per physical file / version ─────────────────────────

export const mediaFiles = sqliteTable(
  'media_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    /** The movie, or the show an episode file belongs to. */
    mediaItemId: integer('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    episodeId: integer('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    mtimeMs: integer('mtime_ms').notNull().default(0),
    container: text('container'),
    durationSeconds: real('duration_seconds'),
    bitrate: integer('bitrate'),
    videoCodec: text('video_codec'),
    videoProfile: text('video_profile'),
    width: integer('width'),
    height: integer('height'),
    frameRate: real('frame_rate'),
    bitDepth: integer('bit_depth'),
    /** `4K` | `1080p` | `720p` | `480p` | `SD` */
    resolution: text('resolution'),
    /** `HDR10` | `HDR10+` | `DV` | `HLG` | null */
    hdr: text('hdr'),
    audioCodec: text('audio_codec'),
    audioChannels: integer('audio_channels'),
    /** All audio/video/subtitle streams as reported by ffprobe (normalised). */
    streams: jsonArray<MediaStreamInfo>('streams'),
    edition: text('edition'),
    source: text('source'),
    releaseGroup: text('release_group'),
    parsed: jsonObject<ParsedFileName>('parsed'),
    probedAt: integer('probed_at', { mode: 'timestamp_ms' }),
    probeError: text('probe_error'),
    /** File disappeared from disk; kept until the next full scan confirms removal. */
    missing: integer('missing', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('media_files_path_uq').on(t.path),
    index('media_files_item_idx').on(t.mediaItemId),
    index('media_files_episode_idx').on(t.episodeId),
  ],
);

// ── subtitle_tracks ──────────────────────────────────────────────────────────

export const subtitleTracks = sqliteTable(
  'subtitle_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    source: text('source').$type<SubtitleSource>().notNull(),
    /** `embedded:<streamIndex>` or `file:<path>` — unique per media file. */
    sourceKey: text('source_key').notNull(),
    streamIndex: integer('stream_index'),
    path: text('path'),
    codec: text('codec').notNull(),
    language: text('language'),
    label: text('label'),
    forced: integer('forced', { mode: 'boolean' }).notNull().default(false),
    hearingImpaired: integer('hearing_impaired', { mode: 'boolean' }).notNull().default(false),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    renderable: integer('renderable', { mode: 'boolean' }).notNull().default(true),
    /** Plugin that discovered or downloaded the track. */
    providerId: text('provider_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('subtitle_tracks_source_uq').on(t.mediaFileId, t.sourceKey)],
);

// ── watch_progress ───────────────────────────────────────────────────────────

export const watchProgress = sqliteTable(
  'watch_progress',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** Movie, or the show that owns the episode. */
    mediaItemId: integer('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    episodeId: integer('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),
    /** Version last played, so "resume" re-opens the same file. */
    mediaFileId: integer('media_file_id').references(() => mediaFiles.id, { onDelete: 'set null' }),
    positionSeconds: real('position_seconds').notNull().default(0),
    durationSeconds: real('duration_seconds'),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
    playCount: integer('play_count').notNull().default(0),
    /** Removed from "Continue watching" by the user; cleared by the next progress update. */
    hiddenFromContinue: integer('hidden_from_continue', { mode: 'boolean' }).notNull().default(false),
    lastWatchedAt: integer('last_watched_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [
    // NULLs are distinct in SQLite unique indexes, so movies and episodes get separate partial indexes.
    uniqueIndex('watch_progress_movie_uq')
      .on(t.profileId, t.mediaItemId)
      .where(sql`${t.episodeId} IS NULL`),
    uniqueIndex('watch_progress_episode_uq')
      .on(t.profileId, t.episodeId)
      .where(sql`${t.episodeId} IS NOT NULL`),
    index('watch_progress_recent_idx').on(t.profileId, t.lastWatchedAt),
  ],
);

// ── watchlist ────────────────────────────────────────────────────────────────

export const watchlist = sqliteTable(
  'watchlist',
  {
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    mediaItemId: integer('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.mediaItemId] })],
);

// ── music ────────────────────────────────────────────────────────────────────
// Music libraries have their own tables: artists → albums → tracks, read from
// file tags (falling back to Artist/Album/NN - Title folders).

export const musicArtists = sqliteTable(
  'music_artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortName: text('sort_name').notNull(),
    /** Normalised name, so "The Beatles" and "the beatles" are one artist. */
    matchKey: text('match_key').notNull(),
    /** `artist.jpg` / `folder.jpg` in the artist's own folder. */
    image: text('image'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('music_artists_identity_uq').on(t.libraryId, t.matchKey),
    index('music_artists_sort_idx').on(t.sortName),
  ],
);

export const musicAlbums = sqliteTable(
  'music_albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    /** Album artist ("Various Artists" for compilations). */
    artistId: integer('artist_id')
      .notNull()
      .references(() => musicArtists.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    matchKey: text('match_key').notNull(),
    year: integer('year'),
    genres: jsonArray<string>('genres'),
    /** A folder image path, or `embedded:<trackId>` for artwork inside a track. */
    cover: text('cover'),
    folderPath: text('folder_path'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('music_albums_identity_uq').on(t.libraryId, t.artistId, t.matchKey),
    index('music_albums_artist_idx').on(t.artistId),
    index('music_albums_created_idx').on(t.createdAt),
  ],
);

export const musicTracks = sqliteTable(
  'music_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    albumId: integer('album_id')
      .notNull()
      .references(() => musicAlbums.id, { onDelete: 'cascade' }),
    /** First credited artist; `artistName` keeps the full credit. */
    artistId: integer('artist_id')
      .notNull()
      .references(() => musicArtists.id, { onDelete: 'cascade' }),
    artistName: text('artist_name').notNull(),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    trackNumber: integer('track_number'),
    discNumber: integer('disc_number'),
    year: integer('year'),
    genres: jsonArray<string>('genres'),
    durationSeconds: real('duration_seconds'),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    mtimeMs: integer('mtime_ms').notNull().default(0),
    container: text('container'),
    codec: text('codec'),
    bitrate: integer('bitrate'),
    sampleRate: integer('sample_rate'),
    channels: integer('channels'),
    hasEmbeddedArt: integer('has_embedded_art', { mode: 'boolean' }).notNull().default(false),
    probedAt: integer('probed_at', { mode: 'timestamp_ms' }),
    probeError: text('probe_error'),
    missing: integer('missing', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('music_tracks_path_uq').on(t.path),
    index('music_tracks_album_idx').on(t.albumId),
    index('music_tracks_artist_idx').on(t.artistId),
    index('music_tracks_library_idx').on(t.libraryId),
  ],
);

export const musicLikes = sqliteTable(
  'music_likes',
  {
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => musicTracks.id, { onDelete: 'cascade' }),
    likedAt: integer('liked_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.trackId] })],
);

/** Per-profile listening history: feeds Quick picks, Listen again and Top songs. */
export const musicPlays = sqliteTable(
  'music_plays',
  {
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => musicTracks.id, { onDelete: 'cascade' }),
    playCount: integer('play_count').notNull().default(0),
    lastPlayedAt: integer('last_played_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.trackId] }), index('music_plays_recent_idx').on(t.profileId, t.lastPlayedAt)],
);

export const playlists = sqliteTable(
  'playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('playlists_profile_idx').on(t.profileId)],
);

/** Playlist entries; the same track may appear more than once. */
export const playlistTracks = sqliteTable(
  'playlist_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => musicTracks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('playlist_tracks_order_idx').on(t.playlistId, t.position)],
);

// ── plugins ──────────────────────────────────────────────────────────────────

export const plugins = sqliteTable('plugins', {
  /** Manifest id. */
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  /** Lower runs first. Seeded from the manifest, editable by the admin. */
  priority: integer('priority').notNull().default(100),
  /** Values saved from Admin > Plugins (secrets included — the DB file is private). */
  settings: jsonObject<Record<string, SettingValue>>('settings'),
  /** Version seen at last successful load. */
  version: text('version'),
  /**
   * When the plugin last changed in a way that can change its results: first
   * load, new version, enabled, settings saved. Unlike `updated_at` it is not
   * touched on every start, so scans retry only titles a changed plugin has not seen.
   */
  configuredAt: integer('configured_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pluginCache = sqliteTable(
  'plugin_cache',
  {
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    /** JSON-encoded value. */
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.key] }), index('plugin_cache_expiry_idx').on(t.expiresAt)],
);

// ── inferred row types ───────────────────────────────────────────────────────

export type Profile = typeof profiles.$inferSelect;
export type Library = typeof libraries.$inferSelect;
export type MediaItem = typeof mediaItems.$inferSelect;
export type Season = typeof seasons.$inferSelect;
export type Episode = typeof episodes.$inferSelect;
export type MediaFile = typeof mediaFiles.$inferSelect;
export type SubtitleTrackRow = typeof subtitleTracks.$inferSelect;
export type WatchProgress = typeof watchProgress.$inferSelect;
export type PluginRow = typeof plugins.$inferSelect;
export type MusicArtist = typeof musicArtists.$inferSelect;
export type MusicAlbum = typeof musicAlbums.$inferSelect;
export type MusicTrack = typeof musicTracks.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
