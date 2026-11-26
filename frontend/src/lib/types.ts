/** Shapes returned by the Streamora API (mirrors backend DTOs). */

export interface ProfilePreferences {
  audioLanguage?: string;
  subtitleLanguage?: string | null;
  subtitleStyle?: { size?: 'small' | 'medium' | 'large'; background?: 'none' | 'shadow' | 'box' };
  autoplayNext?: boolean;
  autoplayPreviews?: boolean;
}

export interface Profile {
  id: number;
  name: string;
  avatar: string;
  isKids: boolean;
  isAdmin: boolean;
  hasPin: boolean;
  preferences?: ProfilePreferences;
  createdAt: string;
}

export interface Health {
  status: string;
  version: string;
  setupRequired: boolean;
  ffmpeg: { ffmpeg: string | null; ffprobe: string | null };
  plugins: { total: number; active: number };
}

export interface PlayTarget {
  fileId: number;
  episodeId: number | null;
  episodeLabel: string | null;
  episodeTitle: string | null;
  positionSeconds: number;
  durationSeconds: number | null;
  resume: boolean;
}

export type MediaKind = 'movie' | 'show';

export interface Card {
  id: number;
  kind: MediaKind;
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
  target?: PlayTarget;
  progress?: number;
}

export interface Row {
  id: string;
  title: string;
  kind: 'continue' | 'standard';
  items: Card[];
}

export interface HomeData {
  hero: (Omit<Card, 'target'> & { target: PlayTarget | null }) | null;
  rows: Row[];
}

export interface Version {
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

export interface SeasonSummary {
  seasonNumber: number;
  title: string | null;
  poster: string | null;
  episodeCount: number;
  watchedCount: number;
}

export interface ItemDetail extends Omit<Card, 'target'> {
  tagline: string | null;
  originalTitle: string | null;
  releaseDate: string | null;
  studios: string[];
  status: string | null;
  cast: Array<{ name: string; character: string | null; photo: string | null }>;
  crew: Array<{ name: string; job: string }>;
  externalIds: Record<string, string>;
  metadataSources: string[];
  locked: boolean;
  library: { id: number; name: string; type: string } | null;
  versions: Version[];
  watched: boolean;
  target: PlayTarget | null;
  seasons: SeasonSummary[];
  similar: Card[];
}

export interface EpisodeEntry {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeNumberEnd: number | null;
  label: string;
  title: string;
  overview: string | null;
  still: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
  fileId: number;
  versions: Version[];
  watched: boolean;
  positionSeconds: number;
  progress: number;
}

export interface SubtitleTrack {
  id: number;
  source: 'embedded' | 'sidecar' | 'downloaded';
  codec: string;
  language: string | null;
  label: string | null;
  forced: boolean;
  hearingImpaired: boolean;
  default: boolean;
  renderable: boolean;
  url: string | null;
}

export interface AudioTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  channels: number | null;
  default: boolean;
}

export interface PlaybackPlan {
  fileId: number;
  method: 'direct' | 'remux' | 'transcode';
  reasons: string[];
  url: string;
  mimeType: string;
  durationSeconds: number | null;
  sessionId: string | null;
  audioStreamIndex: number | null;
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
}

export interface PlayerContext {
  fileId: number;
  item: { id: number; kind: MediaKind; title: string; year: number | null; logo: string | null; backdrop: string | null };
  episode: { id: number; label: string; title: string } | null;
  durationSeconds: number | null;
  resumeSeconds: number;
  versions: Version[];
  next: PlayTarget | null;
  preferences: ProfilePreferences;
}

export type Quality = 'original' | '2160p' | '1080p' | '720p' | '480p';

// ── admin ────────────────────────────────────────────────────────────────────

export type LibraryType = 'movies' | 'shows' | 'anime' | 'music';

export interface Library {
  id: number;
  name: string;
  type: LibraryType;
  paths: string[];
  language: string;
  watch: boolean;
  agents: string[] | null;
  lastScannedAt: string | null;
  createdAt: string;
  /** Music libraries also report albums, songs and artists. */
  counts: { movies: number; shows: number; albums?: number; tracks?: number; artists?: number };
}

export interface ScanProgress {
  phase: 'discovering' | 'probing' | 'saving' | 'cleanup' | 'metadata' | 'subtitles';
  processed: number;
  total: number;
  current?: string;
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
  last: {
    kind: 'full' | 'partial';
    finishedAt: string;
    cancelled?: boolean;
    error?: string;
    added?: number;
    updated?: number;
    removed?: number;
    files?: { added: number; updated: number; removed: number; missing: number; unchanged: number };
    unidentified?: string[];
    errors?: string[];
  } | null;
}

export type PluginStatus = 'active' | 'disabled' | 'needs_config' | 'error' | 'invalid' | 'loading';

export type SettingField = {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  env?: string;
} & (
  | { type: 'string' | 'url'; default?: string; placeholder?: string; pattern?: string }
  | { type: 'secret'; placeholder?: string }
  | { type: 'number'; default?: number; min?: number; max?: number; step?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'select'; options: Array<{ value: string; label: string }>; default?: string }
  | { type: 'list'; default?: string[]; placeholder?: string }
  | { type: 'headers'; default?: Record<string, string> }
);

export type SettingValue = string | number | boolean | string[] | Record<string, string>;

export interface PluginSummary {
  id: string;
  folder: string;
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  capabilities: string[];
  permissions: { network?: string[]; filesystem?: string; ffmpeg?: boolean } | null;
  status: PluginStatus;
  error: string | null;
  enabled: boolean;
  priority: number;
  defaultPriority: number | null;
  missingSettings: string[];
  errors: string[];
  warnings: string[];
  hasSettings: boolean;
  hasHealthCheck: boolean;
  activatedAt: string | null;
}

export interface PluginDetails extends PluginSummary {
  settings: {
    schema: SettingField[];
    values: Record<string, SettingValue | null>;
    sources: Record<string, 'saved' | 'env' | 'default' | 'unset'>;
  };
}

export interface FolderListing {
  path: string | null;
  parent: string | null;
  separator: string;
  entries: Array<{ name: string; path: string }>;
  truncated?: boolean;
  videoCount: number;
}

export interface TranscodeSession {
  id: string;
  profileId: number;
  fileId: number;
  title?: string | null;
  mode: 'remux' | 'transcode';
  encoder: string;
  segments: number;
  ready: number;
  position: number;
  running: { start: number; end: number; produced: number } | null;
  createdAt: string;
  lastAccess: string;
}

export interface SearchCandidate {
  provider: string;
  kind: MediaKind;
  title: string;
  year?: number;
  overview?: string;
  poster?: string;
  externalIds: Record<string, string>;
}
