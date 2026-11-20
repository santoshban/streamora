/** Standardised data models exchanged between Streamora and its plugins. */

export type MediaKind = 'movie' | 'show';

export type LibraryType = 'movies' | 'shows' | 'anime';

/**
 * Artwork reference: either an absolute `http(s)://` URL or an absolute local
 * file path (e.g. a `poster.jpg` sidecar). The server decides how to serve it.
 */
export type ArtworkRef = string;

/** Well-known provider ids. Values are always strings (`tmdb: "603"`, `imdb: "tt0133093"`). */
export interface ExternalIds {
  tmdb?: string;
  imdb?: string;
  tvdb?: string;
  [provider: string]: string | undefined;
}

export interface CastMember {
  name: string;
  character?: string;
  /** Billing order, 0 = top billed. */
  order?: number;
  photo?: ArtworkRef;
}

export interface CrewMember {
  name: string;
  /** e.g. `Director`, `Writer`, `Creator`. */
  job: string;
  department?: string;
  photo?: ArtworkRef;
}

export interface Artwork {
  poster?: ArtworkRef;
  /** Wide background art. Prefer textless images: the UI overlays the title logo. */
  backdrop?: ArtworkRef;
  /** Transparent title treatment (PNG/SVG). */
  logo?: ArtworkRef;
  /** Wide thumbnail with title (used for cards when present). */
  thumb?: ArtworkRef;
}

/** Movie or show level metadata. Every field is optional: providers fill what they know. */
export interface MediaMetadata {
  kind: MediaKind;
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  year?: number;
  /** ISO date `YYYY-MM-DD` (first air date for shows). */
  releaseDate?: string;
  tagline?: string;
  overview?: string;
  genres?: string[];
  /** Studios for movies, networks for shows. */
  studios?: string[];
  /** Certification such as `PG-13`, `TV-MA`, `12`. */
  contentRating?: string;
  /** Community rating on a 0–10 scale. */
  rating?: number;
  runtimeMinutes?: number;
  /** Shows only: `Returning Series`, `Ended`, ... */
  status?: string;
  cast?: CastMember[];
  crew?: CrewMember[];
  artwork?: Artwork;
  externalIds?: ExternalIds;
}

export interface EpisodeMetadata {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  airDate?: string;
  runtimeMinutes?: number;
  rating?: number;
  /** Episode still / thumbnail. */
  still?: ArtworkRef;
  externalIds?: ExternalIds;
}

export interface SeasonMetadata {
  seasonNumber: number;
  title?: string;
  overview?: string;
  airDate?: string;
  poster?: ArtworkRef;
  externalIds?: ExternalIds;
  episodes?: EpisodeMetadata[];
}

// ── Media files & streams ────────────────────────────────────────────────────

export type MediaStreamType = 'video' | 'audio' | 'subtitle' | 'attachment' | 'data';

/** A normalised ffprobe stream. `index` is the absolute stream index inside the file. */
export interface MediaStreamInfo {
  index: number;
  type: MediaStreamType;
  /** ffprobe `codec_name`, e.g. `h264`, `hevc`, `aac`, `subrip`, `hdmv_pgs_subtitle`. */
  codec: string;
  /** Usually ISO 639-2 (`eng`, `fre`), as tagged in the container. */
  language?: string;
  title?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  width?: number;
  height?: number;
  /** ffprobe `profile`, e.g. `High`, `Main 10`, `LC`. */
  profile?: string;
  /** ffprobe `level` (H.264: 41 = 4.1). */
  level?: number;
  /** e.g. `yuv420p`, `yuv420p10le`. */
  pixFmt?: string;
  bitDepth?: number;
  /** Bits per second, when the container reports it. */
  bitRate?: number;
  frameRate?: number;
  interlaced?: boolean;
  /** `smpte2084` (PQ/HDR10), `arib-std-b67` (HLG), `bt709`... */
  colorTransfer?: string;
  default?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
}

export interface MediaFileInfo {
  path: string;
  container?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  streams: MediaStreamInfo[];
}

// ── Subtitles ────────────────────────────────────────────────────────────────

export type SubtitleSource = 'embedded' | 'sidecar' | 'downloaded';

export interface SubtitleTrack {
  source: SubtitleSource;
  /** Embedded tracks: absolute stream index in the media file. */
  streamIndex?: number;
  /** Sidecar / downloaded tracks: absolute path of the subtitle file. */
  path?: string;
  /** Codec or file format: `subrip`, `ass`, `webvtt`, `mov_text`, `srt`, `vtt`, `hdmv_pgs_subtitle`... */
  codec: string;
  language?: string;
  label?: string;
  forced?: boolean;
  hearingImpaired?: boolean;
  default?: boolean;
  /** False for bitmap formats (PGS, VobSub) that cannot become WebVTT without OCR. */
  renderable?: boolean;
}

// ── Streams ──────────────────────────────────────────────────────────────────

/** An alternative playable source contributed by a `stream_resolver` plugin. */
export interface StreamSource {
  /** Stable id, unique within the providing plugin. */
  id: string;
  /** Human label shown in the version picker, e.g. `NAS mirror · 1080p`. */
  name: string;
  /** `file`: absolute local path · `http`: progressive HTTP(S) file · `hls`: an `.m3u8` playlist. */
  protocol: 'file' | 'http' | 'hls';
  url: string;
  /** Headers the server must send when fetching `url` (never exposed to the browser). */
  headers?: Record<string, string>;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  /** `4K`, `1080p`, `720p`, `SD` */
  resolution?: string;
  hdr?: string;
  sizeBytes?: number;
  bitrate?: number;
}
