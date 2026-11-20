import type { PluginContext } from './context.js';
import type {
  ExternalIds,
  LibraryType,
  MediaFileInfo,
  MediaKind,
  MediaMetadata,
  MediaVideo,
  SeasonMetadata,
  StreamSource,
  SubtitleTrack,
  ArtworkRef,
} from './models.js';

/** Passed as the last argument of every capability call. */
export interface CallOptions {
  /** Aborted when the host gives up on the call (timeout, client disconnect, shutdown). */
  signal: AbortSignal;
}

// ── metadata ─────────────────────────────────────────────────────────────────

export interface MetadataMatchRequest {
  kind: MediaKind;
  /** Best known title: parsed from the file/folder name or an earlier provider. */
  title: string;
  year?: number;
  /** BCP 47 language of the library, e.g. `en-US`. */
  language: string;
  libraryType: LibraryType;
  /** Ids gathered so far (from an earlier provider or a manual match). Prefer them over searching. */
  externalIds: ExternalIds;
  /** Movie folder or show root folder. */
  folderPath?: string;
  /** Movie: every version of the movie. Show: empty. */
  filePaths: string[];
  /** Metadata merged from higher-priority providers so far (read-only). */
  current: Readonly<MediaMetadata>;
}

export interface MetadataMatchResult extends MediaMetadata {
  /** 0..1 — how sure the provider is that this is the right title. */
  confidence?: number;
}

export interface MetadataSeasonRequest {
  show: {
    title: string;
    year?: number;
    externalIds: ExternalIds;
    folderPath?: string;
  };
  seasonNumber: number;
  language: string;
  /** Episodes present on disk for this season. */
  episodes: Array<{ seasonNumber: number; episodeNumber: number; filePaths: string[] }>;
}

export interface MetadataSearchQuery {
  kind: MediaKind;
  query: string;
  year?: number;
  language: string;
}

export interface MetadataSearchResult {
  kind: MediaKind;
  title: string;
  year?: number;
  overview?: string;
  poster?: ArtworkRef;
  externalIds: ExternalIds;
}

export interface MetadataVideosRequest {
  kind: MediaKind;
  title: string;
  year?: number;
  /** BCP 47 language of the library, e.g. `en-US`. */
  language: string;
  externalIds: ExternalIds;
}

export interface MetadataProvider {
  /** Identify a movie/show and return what this provider knows, or `null`. */
  match(request: MetadataMatchRequest, options: CallOptions): Promise<MetadataMatchResult | null>;
  /** Trailers and teasers for a title, best first (shown as previews while browsing). */
  getVideos?(request: MetadataVideosRequest, options: CallOptions): Promise<MediaVideo[]>;
  /** Season + episode details for a show. */
  getSeason?(request: MetadataSeasonRequest, options: CallOptions): Promise<SeasonMetadata | null>;
  /** Candidate list for the manual "Fix match" dialog. */
  search?(query: MetadataSearchQuery, options: CallOptions): Promise<MetadataSearchResult[]>;
}

// ── subtitles ────────────────────────────────────────────────────────────────

export interface SubtitleFileContext extends MediaFileInfo {
  /** Every video file in the same folder (helps decide whether loose subtitle files belong to this one). */
  siblingVideoPaths: string[];
}

export interface SubtitleSearchQuery {
  kind: 'movie' | 'episode';
  title: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  /** ISO 639-2 codes, in order of preference. */
  languages: string[];
  externalIds: ExternalIds;
  file: MediaFileInfo;
}

export interface SubtitleSearchResult {
  /** Provider-specific id used by `download`. */
  id: string;
  language: string;
  label: string;
  format: 'srt' | 'vtt' | 'ass' | 'ssa';
  hearingImpaired?: boolean;
  forced?: boolean;
  /** Higher is better; used to sort results across providers. */
  score?: number;
}

export interface SubtitleDownload {
  format: 'srt' | 'vtt' | 'ass' | 'ssa';
  content: string;
  language?: string;
}

export interface SubtitleProvider {
  /** Discover tracks that belong to a media file (embedded streams, sidecar files...). */
  discover?(file: SubtitleFileContext, options: CallOptions): Promise<SubtitleTrack[]>;
  /** Produce WebVTT text for a track, or `null` if this provider cannot handle it. */
  render?(track: SubtitleTrack, file: MediaFileInfo, options: CallOptions): Promise<string | null>;
  /** Third-party scrapers: search an online subtitle database. */
  search?(query: SubtitleSearchQuery, options: CallOptions): Promise<SubtitleSearchResult[]>;
  download?(result: SubtitleSearchResult, options: CallOptions): Promise<SubtitleDownload>;
}

// ── stream_resolver ──────────────────────────────────────────────────────────

export interface StreamResolveRequest {
  kind: 'movie' | 'episode';
  title: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  externalIds: ExternalIds;
  /** Local versions already known to the library. */
  files: MediaFileInfo[];
}

export interface StreamResolver {
  resolve(request: StreamResolveRequest, options: CallOptions): Promise<StreamSource[]>;
}

// ── post_scan ────────────────────────────────────────────────────────────────

export interface ScannedItemRef {
  id: number;
  kind: MediaKind;
  title: string;
  year?: number;
  externalIds: ExternalIds;
  files: MediaFileInfo[];
}

export interface ScanCompletedEvent {
  library: { id: number; name: string; type: LibraryType; paths: string[] };
  startedAt: string;
  finishedAt: string;
  added: ScannedItemRef[];
  updated: ScannedItemRef[];
  removed: Array<{ id: number; kind: MediaKind; title: string }>;
}

export interface PostScanHook {
  onScanComplete(event: ScanCompletedEvent, options: CallOptions): Promise<void>;
}

// ── plugin entry point ───────────────────────────────────────────────────────

export interface HealthCheckResult {
  ok: boolean;
  message?: string;
}

/**
 * What a plugin factory returns. Implement the property for every capability
 * declared in the manifest:
 * `metadata` → `metadata`, `subtitles` → `subtitles`,
 * `stream_resolver` → `streamResolver`, `post_scan` → `postScan`.
 */
export interface PluginInstance {
  metadata?: MetadataProvider;
  subtitles?: SubtitleProvider;
  streamResolver?: StreamResolver;
  postScan?: PostScanHook;
  /** Shown by the "Test" button in Admin > Plugins (e.g. validate an API key). */
  healthCheck?(options: CallOptions): Promise<HealthCheckResult>;
  /** Called before the instance is discarded (disable, reload, settings change, shutdown). */
  dispose?(): void | Promise<void>;
}

/**
 * The entry module's default export. Called once per activation; settings
 * changes and hot reloads create a fresh instance with a fresh context.
 */
export type PluginFactory = (ctx: PluginContext) => PluginInstance | Promise<PluginInstance>;
