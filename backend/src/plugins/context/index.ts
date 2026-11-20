import type { PluginContext, PluginLogger, SettingValue } from '@streamora/plugin-sdk';
import type { Logger } from '../../lib/logger.js';
import type { DB } from '../../db/client.js';
import type { NormalizedManifest } from '../manifest.js';
import { SqlitePluginCache } from './cache.js';
import { createPluginFfmpeg } from './ffmpeg.js';
import { createPluginFs } from './fs.js';
import { PluginHttpClientImpl } from './http.js';
import { RateLimiter } from './rate-limiter.js';

export const DEFAULT_RATE_LIMIT = { requests: 10, intervalMs: 1000 };

export interface CreateContextOptions {
  manifest: NormalizedManifest;
  dir: string;
  dataDir: string;
  settings: Record<string, SettingValue | undefined>;
  db: DB;
  log: Logger;
  signal: AbortSignal;
  serverVersion: string;
  libraryRoots: () => string[];
  ffmpegPath: string;
  ffprobePath: string;
  fetchImpl?: typeof fetch;
}

function adaptLogger(log: Logger): PluginLogger {
  return {
    debug: (msg, data) => log.debug(data ?? {}, msg),
    info: (msg, data) => log.info(data ?? {}, msg),
    warn: (msg, data) => log.warn(data ?? {}, msg),
    error: (msg, data) => log.error(data ?? {}, msg),
  };
}

/** Expands `setting:<key>` entries of `permissions.network` into host names. */
export function resolveAllowedHosts(
  manifest: NormalizedManifest,
  settings: Record<string, SettingValue | undefined>,
): string[] {
  const hosts: string[] = [];
  for (const entry of manifest.permissions.network) {
    if (!entry.startsWith('setting:')) {
      hosts.push(entry);
      continue;
    }
    const value = settings[entry.slice('setting:'.length)];
    if (typeof value !== 'string' || value === '') continue;
    try {
      hosts.push(new URL(value).hostname);
    } catch {
      // invalid URLs are rejected by settings validation; ignore here
    }
  }
  return hosts;
}

export function createPluginContext(options: CreateContextOptions): PluginContext {
  const { manifest, settings, signal } = options;
  const log = options.log.child({ plugin: manifest.id });
  const rate = manifest.rateLimit ?? DEFAULT_RATE_LIMIT;

  const http = new PluginHttpClientImpl({
    pluginId: manifest.id,
    userAgent: `Streamora/${options.serverVersion} (plugin ${manifest.id}/${manifest.version})`,
    allowedHosts: resolveAllowedHosts(manifest, settings),
    limiter: new RateLimiter(rate.requests, rate.intervalMs),
    signal,
    fetchImpl: options.fetchImpl,
    onRequest: (info) => log.debug(info, 'http request'),
  });

  return Object.freeze({
    plugin: Object.freeze({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      dir: options.dir,
      dataDir: options.dataDir,
    }),
    settings: Object.freeze({ ...settings }),
    log: adaptLogger(log),
    http,
    cache: new SqlitePluginCache(options.db, manifest.id),
    fs: createPluginFs({
      pluginId: manifest.id,
      allowLibraryRead: manifest.permissions.filesystem === 'library-read',
      libraryRoots: options.libraryRoots,
      pluginDir: options.dir,
      dataDir: options.dataDir,
    }),
    ffmpeg: createPluginFfmpeg({
      pluginId: manifest.id,
      allowed: manifest.permissions.ffmpeg,
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      signal,
    }),
    signal,
  });
}
