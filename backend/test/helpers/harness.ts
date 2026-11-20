/**
 * Test utilities shared by backend and plugin tests. Builds real
 * PluginContexts (in-memory SQLite cache, real fs/http guards) so plugin tests
 * exercise the same host code that runs in production.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import type { PluginContext, PluginFactory, PluginInstance, SettingValue } from '@streamora/plugin-sdk';
import { openDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createPluginContext } from '../../src/plugins/context/index.js';
import { validateManifest, type NormalizedManifest } from '../../src/plugins/manifest.js';
import { resolveSettings } from '../../src/plugins/settings.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

/** Set TEST_LOG_LEVEL=debug to see host and plugin logs while debugging tests. */
export const silentLogger = () => pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

export function tempDir(prefix = 'streamora-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

export function readManifest(pluginDir: string): NormalizedManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
  const result = validateManifest(raw);
  if (!result.ok) throw new Error(`Invalid manifest in ${pluginDir}: ${result.errors.join('; ')}`);
  return result.manifest;
}

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch stub that records calls and dispatches on `METHOD pathname`. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const route = routes[key] ?? routes[url.pathname];
    if (!route) return json({ status_message: `no mock for ${key}` }, 404);
    return route(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export interface TestPlugin {
  ctx: PluginContext;
  instance: PluginInstance;
  manifest: NormalizedManifest;
  database: DatabaseHandle;
  abort: AbortController;
  dataDir: string;
  close(): void;
}

/** Loads a plugin's entry module directly (Vitest transpiles TS) with a real host context. */
export async function loadTestPlugin(
  pluginDir: string,
  options: {
    settings?: Record<string, SettingValue>;
    fetchImpl?: typeof fetch;
    libraryRoots?: string[];
  } = {},
): Promise<TestPlugin> {
  const manifest = readManifest(pluginDir);
  const database = openDatabase(':memory:');
  const abort = new AbortController();
  const dataDir = tempDir('streamora-plugin-data-');
  const resolved = resolveSettings(manifest.settings, options.settings ?? {}, {});

  const ctx = createPluginContext({
    manifest,
    dir: pluginDir,
    dataDir,
    settings: resolved.values,
    db: database.db,
    log: silentLogger(),
    signal: abort.signal,
    serverVersion: 'test',
    libraryRoots: () => options.libraryRoots ?? [],
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
    fetchImpl: options.fetchImpl,
  });

  const mod = (await import(path.join(pluginDir, manifest.main))) as { default: PluginFactory };
  const instance = await mod.default(ctx);
  return {
    ctx,
    instance,
    manifest,
    database,
    abort,
    dataDir,
    close() {
      abort.abort();
      database.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const callOptions = () => ({ signal: new AbortController().signal });

/** Polls until `check` returns truthy (for hot-reload/file-watcher tests). */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 10_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
