import type { PluginSettings } from './manifest.js';

/**
 * Everything the host hands to a plugin. Plugins run in-process and are
 * trusted code; these helpers are guard rails (allow-lists, throttling,
 * timeouts, size caps) rather than a security sandbox.
 */
export interface PluginContext {
  readonly plugin: PluginInfo;
  /** Resolved settings: saved value → env seed → manifest default. */
  readonly settings: PluginSettings;
  readonly log: PluginLogger;
  readonly http: PluginHttpClient;
  readonly cache: PluginCache;
  readonly fs: PluginFileSystem;
  readonly ffmpeg: PluginFfmpeg;
  /** Aborted when the plugin is disabled, reloaded or the server shuts down. */
  readonly signal: AbortSignal;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** Absolute path of the plugin folder. */
  dir: string;
  /** Absolute path of a private, writable folder (`$DATA_DIR/plugins/<id>`). */
  dataDir: string;
}

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequestOptions {
  method?: HttpMethod;
  /** Appended to the URL; `undefined`/`null` values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  /** Plain objects/arrays are JSON-encoded with `content-type: application/json`. */
  body?: string | Uint8Array | Record<string, unknown> | unknown[];
  /** Default 15 000 ms. */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 5xx (honours `Retry-After`). Default 2. */
  retries?: number;
  /** Response bodies larger than this are rejected. Default 20 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** A fully-buffered response. */
export interface HttpResponse {
  url: string;
  status: number;
  ok: boolean;
  headers: Readonly<Record<string, string>>;
  text(): string;
  json<T = unknown>(): T;
  bytes(): Uint8Array;
}

export interface PluginHttpClient {
  /** Never throws for HTTP status codes; throws for network errors, timeouts and blocked hosts. */
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  /** Throws a {@link PluginHttpError} for non-2xx responses. */
  getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  getText(url: string, options?: HttpRequestOptions): Promise<string>;
  getBytes(url: string, options?: HttpRequestOptions): Promise<Uint8Array>;
}

/** Shape of errors thrown by `getJson`/`getText`/`getBytes` for non-2xx responses. */
export interface PluginHttpError extends Error {
  name: 'PluginHttpError';
  status: number;
  url: string;
  /** First 2 KiB of the response body. */
  body?: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** Persistent (SQLite-backed) key/value cache, namespaced per plugin. Values must be JSON-serialisable. */
export interface PluginCache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** `ttlMs` omitted → never expires. */
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Returns the cached value or runs `producer` and caches its result (unless it is `undefined`). */
  wrap<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T>;
  clear(): Promise<void>;
}

// ── File system ──────────────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface ReadTextOptions {
  /** Default 5 MiB. */
  maxBytes?: number;
  /**
   * `auto` (default) honours UTF-8/UTF-16 BOMs, then tries strict UTF-8 and
   * falls back to Windows-1252, which is common for older subtitle files.
   */
  encoding?: 'auto' | 'utf8' | 'latin1';
}

/**
 * Read-only access to library folders (requires `permissions.filesystem: "library-read"`)
 * plus read/write access to the plugin's private `dataDir`. All paths are absolute.
 */
export interface PluginFileSystem {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileEntry | null>;
  list(dir: string): Promise<FileEntry[]>;
  readText(path: string, options?: ReadTextOptions): Promise<string>;
  readBytes(path: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  /** Paths are relative to `ctx.plugin.dataDir`. */
  readData(relativePath: string): Promise<Uint8Array | null>;
  /** Returns the absolute path written. */
  writeData(relativePath: string, data: string | Uint8Array): Promise<string>;
  removeData(relativePath: string): Promise<void>;
}

// ── FFmpeg ───────────────────────────────────────────────────────────────────

export interface FfmpegRunOptions {
  /** Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** stdout larger than this aborts the process. Default 64 MiB. */
  maxOutputBytes?: number;
}

export interface FfmpegRunResult {
  /** Process exit code (`null` when killed). */
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
}

/** Raw `ffprobe -show_format -show_streams -of json` output (loosely typed). */
export interface FfprobeResult {
  format?: Record<string, unknown> & {
    filename?: string;
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: Array<
    Record<string, unknown> & {
      index: number;
      codec_type?: string;
      codec_name?: string;
      tags?: Record<string, string>;
      disposition?: Record<string, number>;
    }
  >;
}

/** Requires `permissions.ffmpeg: true`. */
export interface PluginFfmpeg {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /** Runs ffmpeg with the given arguments (no shell). */
  run(args: string[], options?: FfmpegRunOptions): Promise<FfmpegRunResult>;
  probe(path: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FfprobeResult>;
}
