import fs from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { eq } from 'drizzle-orm';
import type {
  CallOptions,
  HealthCheckResult,
  PluginCapability,
  PluginInstance,
  SettingField,
  SettingValue,
} from '@streamora/plugin-sdk';
import type { DB } from '../db/client.js';
import { libraries, plugins as pluginsTable, type PluginRow } from '../db/schema.js';
import { badRequest, conflict, errorMessage, notFound } from '../lib/errors.js';
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { clearPluginCache, purgeExpiredCache } from './context/cache.js';
import { createPluginContext } from './context/index.js';
import { callWithTimeout } from './invoke.js';
import {
  bundlePlugin,
  discoverPlugins,
  importPluginFactory,
  isIgnoredPluginFolder,
  readPluginFolder,
  resetBundleCache,
  type DiscoveredPlugin,
} from './loader.js';
import { PLUGIN_CAPABILITIES, type NormalizedManifest } from './manifest.js';
import {
  applySettingsUpdate,
  maskSettings,
  parseSettingsUpdate,
  resolveSettings,
  type SettingSource,
} from './settings.js';

export type PluginStatus = 'active' | 'disabled' | 'needs_config' | 'error' | 'invalid' | 'loading';

export const CAPABILITY_PROPERTY = {
  metadata: 'metadata',
  subtitles: 'subtitles',
  stream_resolver: 'streamResolver',
  post_scan: 'postScan',
} as const satisfies Record<PluginCapability, keyof PluginInstance>;

type CapabilityProperty = typeof CAPABILITY_PROPERTY;
export type CapabilityImpl<C extends PluginCapability> = NonNullable<PluginInstance[CapabilityProperty[C]]>;

export interface ActivePlugin<C extends PluginCapability> {
  id: string;
  name: string;
  priority: number;
  impl: CapabilityImpl<C>;
}

interface PluginRecord {
  folder: string;
  dir: string;
  manifest?: NormalizedManifest;
  manifestErrors: string[];
  warnings: string[];
  status: PluginStatus;
  error?: string;
  missingSettings: string[];
  instance?: PluginInstance;
  controller?: AbortController;
  bundleHash?: string;
  activatedAt?: Date;
}

export interface PluginSummary {
  id: string;
  folder: string;
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  capabilities: PluginCapability[];
  permissions: NormalizedManifest['permissions'] | null;
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
    sources: Record<string, SettingSource>;
  };
}

export interface PluginManagerOptions {
  db: DB;
  log: Logger;
  events: EventBus;
  pluginsDir: string;
  /** `$DATA_DIR` — plugin data lives in `$DATA_DIR/plugins/<id>`. */
  dataDir: string;
  /** Compiled bundles are written to `<cacheDir>/plugins`. */
  cacheDir: string;
  hotReload: boolean;
  callTimeoutMs: number;
  serverVersion: string;
  ffmpegPath: string;
  ffprobePath: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Checks that the object returned by a plugin factory implements every declared capability. */
export function validatePluginInstance(
  manifest: NormalizedManifest,
  instance: unknown,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!instance || typeof instance !== 'object') {
    return { errors: ['the factory must return an object (PluginInstance)'], warnings };
  }
  const inst = instance as Record<string, unknown>;

  for (const cap of PLUGIN_CAPABILITIES) {
    const prop = CAPABILITY_PROPERTY[cap];
    const impl = inst[prop];
    if (!manifest.capabilities.includes(cap)) {
      if (impl !== undefined) {
        warnings.push(`implements "${prop}" but the manifest does not declare "${cap}"; it is ignored`);
      }
      continue;
    }
    if (!impl || typeof impl !== 'object') {
      errors.push(`declares the "${cap}" capability but returns no "${prop}" object`);
      continue;
    }
    const methods = impl as Record<string, unknown>;
    const isFn = (name: string) => typeof methods[name] === 'function';
    const optional = (name: string) => {
      if (methods[name] !== undefined && !isFn(name)) errors.push(`${prop}.${name} must be a function`);
    };

    switch (cap) {
      case 'metadata':
        if (!isFn('match')) errors.push('metadata.match must be a function');
        optional('getSeason');
        optional('search');
        break;
      case 'subtitles':
        ['discover', 'render', 'search', 'download'].forEach(optional);
        if (!['discover', 'render', 'search'].some(isFn)) {
          errors.push('subtitles must implement at least one of discover, render or search');
        }
        if (isFn('search') !== isFn('download')) errors.push('subtitles.search and subtitles.download go together');
        break;
      case 'stream_resolver':
        if (!isFn('resolve')) errors.push('streamResolver.resolve must be a function');
        break;
      case 'post_scan':
        if (!isFn('onScanComplete')) errors.push('postScan.onScanComplete must be a function');
        break;
    }
  }

  for (const name of ['healthCheck', 'dispose']) {
    if (inst[name] !== undefined && typeof inst[name] !== 'function') errors.push(`${name} must be a function`);
  }
  return { errors, warnings };
}

export class PluginManager {
  private readonly records = new Map<string, PluginRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private watcher?: FSWatcher;
  private purgeTimer?: NodeJS.Timeout;
  private closed = false;
  /** Incremented per activation; makes each import a fresh module. */
  private generation = 0;
  readonly bundleDir: string;

  constructor(private readonly opts: PluginManagerOptions) {
    this.bundleDir = path.join(opts.cacheDir, 'plugins');
  }

  private get log(): Logger {
    return this.opts.log;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await resetBundleCache(this.bundleDir);
    purgeExpiredCache(this.opts.db);
    this.purgeTimer = setInterval(() => purgeExpiredCache(this.opts.db), 60 * 60_000);
    this.purgeTimer.unref();

    await this.syncAll();
    if (this.opts.hotReload) await this.startWatching();

    const counts = this.list().reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});
    this.log.info({ pluginsDir: this.opts.pluginsDir, ...counts }, 'Plugins loaded');
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    await this.watcher?.close();
    await Promise.all([...this.records.values()].map((r) => this.withLock(r.folder, () => this.deactivate(r))));
  }

  /** Re-scans the plugins folder: loads new plugins, unloads removed ones, reloads the rest. */
  async syncAll(): Promise<void> {
    const discovered = await discoverPlugins(this.opts.pluginsDir);
    const present = new Set(discovered.map((d) => d.folder));
    for (const folder of [...this.records.keys()]) {
      if (!present.has(folder)) await this.withLock(folder, () => this.remove(folder));
    }
    await Promise.all(discovered.map((found) => this.withLock(found.folder, () => this.apply(found))));
    this.opts.events.emit('plugins.changed', { reason: 'discovered' });
  }

  private withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(op, op);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  private async apply(found: DiscoveredPlugin): Promise<void> {
    const existing = this.records.get(found.folder);
    if (existing) await this.deactivate(existing);
    const record: PluginRecord = {
      folder: found.folder,
      dir: found.dir,
      manifest: found.manifest,
      manifestErrors: found.errors,
      warnings: [...found.warnings],
      status: 'loading',
      missingSettings: [],
    };
    this.records.set(found.folder, record);
    await this.activate(record);
  }

  private async remove(folder: string): Promise<void> {
    const record = this.records.get(folder);
    if (!record) return;
    await this.deactivate(record);
    this.records.delete(folder);
    this.log.info({ folder }, 'Plugin removed');
  }

  private ensureRow(manifest: NormalizedManifest): PluginRow {
    const { db } = this.opts;
    const existing = db.select().from(pluginsTable).where(eq(pluginsTable.id, manifest.id)).get();
    if (existing) return existing;
    db.insert(pluginsTable)
      .values({ id: manifest.id, enabled: manifest.enabledByDefault, priority: manifest.priority, settings: {} })
      .onConflictDoNothing()
      .run();
    return db.select().from(pluginsTable).where(eq(pluginsTable.id, manifest.id)).get()!;
  }

  private getRow(id: string): PluginRow | undefined {
    return this.opts.db.select().from(pluginsTable).where(eq(pluginsTable.id, id)).get();
  }

  private setStatus(record: PluginRecord, status: PluginStatus, error?: string): void {
    record.status = status;
    record.error = error;
    const id = record.manifest?.id ?? record.folder;
    this.opts.events.emit('plugin.status', { id, status, ...(error ? { error } : {}) });
  }

  private libraryRoots = (): string[] =>
    this.opts.db
      .select({ paths: libraries.paths })
      .from(libraries)
      .all()
      .flatMap((r) => r.paths);

  private async activate(record: PluginRecord): Promise<void> {
    const manifest = record.manifest;
    if (!manifest) {
      this.setStatus(record, 'invalid', record.manifestErrors.join('; '));
      this.log.warn({ folder: record.folder, errors: record.manifestErrors }, 'Invalid plugin');
      return;
    }

    const row = this.ensureRow(manifest);
    record.missingSettings = [];
    if (!row.enabled) {
      this.setStatus(record, 'disabled');
      return;
    }

    const resolved = resolveSettings(manifest.settings, row.settings, this.opts.env ?? process.env);
    if (resolved.missingRequired.length) {
      record.missingSettings = resolved.missingRequired;
      this.setStatus(record, 'needs_config', `Missing required settings: ${resolved.missingRequired.join(', ')}`);
      this.log.info({ plugin: manifest.id, missing: resolved.missingRequired }, 'Plugin needs configuration');
      return;
    }

    this.setStatus(record, 'loading');
    const controller = new AbortController();
    try {
      const bundle = await bundlePlugin({ dir: record.dir, manifest }, this.bundleDir);
      const factory = await importPluginFactory(bundle, ++this.generation);
      const dataDir = path.join(this.opts.dataDir, 'plugins', manifest.id);
      await fs.mkdir(dataDir, { recursive: true });

      const ctx = createPluginContext({
        manifest,
        dir: record.dir,
        dataDir,
        settings: resolved.values,
        db: this.opts.db,
        log: this.opts.log,
        signal: controller.signal,
        serverVersion: this.opts.serverVersion,
        libraryRoots: this.libraryRoots,
        ffmpegPath: this.opts.ffmpegPath,
        ffprobePath: this.opts.ffprobePath,
        fetchImpl: this.opts.fetchImpl,
      });

      const instance = await callWithTimeout(
        `Activating plugin "${manifest.id}"`,
        () => factory(ctx),
        this.opts.callTimeoutMs,
        [controller.signal],
      );
      const check = validatePluginInstance(manifest, instance);
      record.warnings.push(...check.warnings);
      if (check.errors.length) throw new Error(`Invalid plugin instance: ${check.errors.join('; ')}`);

      record.instance = instance;
      record.controller = controller;
      record.bundleHash = bundle.hash;
      record.activatedAt = new Date();
      const previous = this.getRow(manifest.id);
      this.opts.db
        .update(pluginsTable)
        .set({
          version: manifest.version,
          lastError: null,
          ...(previous?.version !== manifest.version || !previous?.configuredAt ? { configuredAt: new Date() } : {}),
        })
        .where(eq(pluginsTable.id, manifest.id))
        .run();
      this.setStatus(record, 'active');
      this.log.info({ plugin: manifest.id, version: manifest.version, hash: bundle.hash }, 'Plugin activated');
    } catch (err) {
      controller.abort(new Error('Plugin activation failed'));
      const message = errorMessage(err);
      this.opts.db.update(pluginsTable).set({ lastError: message }).where(eq(pluginsTable.id, manifest.id)).run();
      this.setStatus(record, 'error', message);
      this.log.error({ plugin: manifest.id, err }, 'Plugin failed to activate');
    }
  }

  private async deactivate(record: PluginRecord): Promise<void> {
    const { instance, controller } = record;
    record.instance = undefined;
    record.controller = undefined;
    record.activatedAt = undefined;
    if (!instance) return;
    controller?.abort(new Error('Plugin unloaded'));
    try {
      await callWithTimeout(`Disposing plugin "${record.manifest?.id}"`, async () => instance.dispose?.(), 5_000);
    } catch (err) {
      this.log.warn({ plugin: record.manifest?.id, err }, 'Plugin dispose failed');
    }
  }

  // ── hot reload ─────────────────────────────────────────────────────────────

  private async startWatching(): Promise<void> {
    await fs.mkdir(this.opts.pluginsDir, { recursive: true });
    const watcher = watch(this.opts.pluginsDir, {
      ignoreInitial: true,
      ignored: (p: string) => /[\\/](node_modules|\.git|dist)([\\/]|$)/.test(p),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      depth: 8,
    });
    this.watcher = watcher;
    watcher.on('all', (_event, changed) => this.onFileChange(changed));
    watcher.on('error', (err) => this.log.warn({ err }, 'Plugin watcher error'));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    this.log.info('Plugin hot reload enabled');
  }

  private onFileChange(changed: string): void {
    if (this.closed) return;
    const rel = path.relative(this.opts.pluginsDir, changed);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const folder = rel.split(/[\\/]/)[0]!;
    if (isIgnoredPluginFolder(folder)) return;

    clearTimeout(this.debounceTimers.get(folder));
    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        this.withLock(folder, () => this.refreshFolder(folder)).catch((err) =>
          this.log.error({ folder, err }, 'Plugin hot reload failed'),
        );
      }, 300),
    );
  }

  private async refreshFolder(folder: string): Promise<void> {
    if (this.closed) return;
    const dir = path.join(this.opts.pluginsDir, folder);
    const isDir = await fs.stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) {
      if (this.records.has(folder)) {
        await this.remove(folder);
        this.opts.events.emit('plugins.changed', { reason: 'removed' });
      }
      return;
    }

    const found = await readPluginFolder(dir);
    if (found.manifest) {
      const clash = [...this.records.values()].find((r) => r.folder !== folder && r.manifest?.id === found.manifest!.id);
      if (clash) {
        found.errors.push(`duplicate plugin id "${found.manifest.id}" (already used by folder "${clash.folder}")`);
        delete found.manifest;
      }
    }
    this.log.info({ folder }, 'Plugin files changed, reloading');
    await this.apply(found);
    this.opts.events.emit('plugins.changed', { reason: 'reloaded' });
  }

  // ── queries ────────────────────────────────────────────────────────────────

  private findById(id: string): PluginRecord | undefined {
    for (const record of this.records.values()) if (record.manifest?.id === id) return record;
    const byFolder = this.records.get(id);
    return byFolder && !byFolder.manifest ? byFolder : undefined;
  }

  private requireById(id: string): PluginRecord {
    const record = this.findById(id);
    if (!record) throw notFound(`Plugin "${id}" not found`);
    return record;
  }

  private requireManifest(record: PluginRecord): NormalizedManifest {
    if (!record.manifest) throw conflict(`Plugin folder "${record.folder}" has an invalid manifest`);
    return record.manifest;
  }

  private summarize(record: PluginRecord, row = record.manifest ? this.getRow(record.manifest.id) : undefined): PluginSummary {
    const m = record.manifest;
    return {
      id: m?.id ?? record.folder,
      folder: record.folder,
      name: m?.name ?? record.folder,
      version: m?.version ?? null,
      description: m?.description ?? null,
      author: m?.author ?? null,
      homepage: m?.homepage ?? null,
      capabilities: m?.capabilities ?? [],
      permissions: m?.permissions ?? null,
      status: record.status,
      error: record.error ?? null,
      enabled: row?.enabled ?? false,
      priority: row?.priority ?? m?.priority ?? 100,
      defaultPriority: m?.priority ?? null,
      missingSettings: record.missingSettings,
      errors: record.manifestErrors,
      warnings: record.warnings,
      hasSettings: (m?.settings.length ?? 0) > 0,
      hasHealthCheck: typeof record.instance?.healthCheck === 'function',
      activatedAt: record.activatedAt?.toISOString() ?? null,
    };
  }

  list(): PluginSummary[] {
    return [...this.records.values()]
      .map((r) => this.summarize(r))
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }

  get(id: string): PluginDetails {
    const record = this.requireById(id);
    const summary = this.summarize(record);
    const manifest = record.manifest;
    if (!manifest) return { ...summary, settings: { schema: [], values: {}, sources: {} } };
    const row = this.getRow(manifest.id);
    const resolved = resolveSettings(manifest.settings, row?.settings ?? {}, this.opts.env ?? process.env);
    return {
      ...summary,
      settings: {
        schema: manifest.settings,
        values: maskSettings(manifest.settings, resolved.values),
        sources: resolved.sources,
      },
    };
  }

  /** Active plugins implementing `capability`, ordered by priority (lowest first). */
  getActive<C extends PluginCapability>(capability: C): ActivePlugin<C>[] {
    const priorities = new Map(
      this.opts.db
        .select({ id: pluginsTable.id, priority: pluginsTable.priority })
        .from(pluginsTable)
        .all()
        .map((r) => [r.id, r.priority]),
    );
    const prop = CAPABILITY_PROPERTY[capability];
    const active: ActivePlugin<C>[] = [];
    for (const record of this.records.values()) {
      const m = record.manifest;
      const impl = record.instance?.[prop];
      if (record.status !== 'active' || !m || !impl || !m.capabilities.includes(capability)) continue;
      active.push({ id: m.id, name: m.name, priority: priorities.get(m.id) ?? m.priority, impl: impl as CapabilityImpl<C> });
    }
    return active.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /**
   * Calls into a plugin with a timeout and an AbortSignal that also fires when
   * the plugin is unloaded. Errors propagate to the caller.
   */
  invoke<T>(
    pluginId: string,
    label: string,
    fn: (options: CallOptions) => Promise<T>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const record = this.findById(pluginId);
    if (!record || record.status !== 'active' || !record.instance) {
      return Promise.reject(new Error(`Plugin "${pluginId}" is not active`));
    }
    return callWithTimeout(`${pluginId}.${label}`, fn, options.timeoutMs ?? this.opts.callTimeoutMs, [
      record.controller?.signal,
      options.signal,
    ]);
  }

  // ── admin operations ───────────────────────────────────────────────────────

  async setEnabled(id: string, enabled: boolean): Promise<PluginDetails> {
    const record = this.requireById(id);
    const manifest = this.requireManifest(record);
    await this.withLock(record.folder, async () => {
      this.ensureRow(manifest);
      this.opts.db
        .update(pluginsTable)
        .set({ enabled, ...(enabled ? { configuredAt: new Date() } : {}) })
        .where(eq(pluginsTable.id, manifest.id))
        .run();
      await this.deactivate(record);
      await this.activate(record);
    });
    this.opts.events.emit('plugins.changed', { reason: 'updated' });
    return this.get(id);
  }

  async setPriority(id: string, priority: number): Promise<PluginDetails> {
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
      throw badRequest('priority must be an integer between 0 and 1000');
    }
    const manifest = this.requireManifest(this.requireById(id));
    this.ensureRow(manifest);
    this.opts.db.update(pluginsTable).set({ priority }).where(eq(pluginsTable.id, manifest.id)).run();
    this.opts.events.emit('plugins.changed', { reason: 'updated' });
    return this.get(id);
  }

  async updateSettings(id: string, update: unknown): Promise<PluginDetails> {
    const record = this.requireById(id);
    const manifest = this.requireManifest(record);
    const parsed = parseSettingsUpdate(manifest.settings, update);
    if (!parsed.ok) throw badRequest('Invalid plugin settings', parsed.errors);

    await this.withLock(record.folder, async () => {
      const row = this.ensureRow(manifest);
      const next = applySettingsUpdate(manifest.settings, row.settings, parsed.values);
      this.opts.db.update(pluginsTable).set({ settings: next, configuredAt: new Date() }).where(eq(pluginsTable.id, manifest.id)).run();
      // Settings are baked into the context, so start a fresh instance.
      await this.deactivate(record);
      await this.activate(record);
    });
    this.opts.events.emit('plugins.changed', { reason: 'updated' });
    return this.get(id);
  }

  /** Re-reads the manifest and code from disk and restarts the plugin. */
  async reload(id: string): Promise<PluginDetails> {
    const record = this.requireById(id);
    await this.withLock(record.folder, () => this.refreshFolder(record.folder));
    const fresh = this.records.get(record.folder);
    if (!fresh) throw notFound(`Plugin "${id}" no longer exists on disk`);
    return this.get(fresh.manifest?.id ?? fresh.folder);
  }

  async healthCheck(id: string): Promise<HealthCheckResult> {
    const record = this.requireById(id);
    if (record.status !== 'active' || !record.instance) {
      return { ok: false, message: record.error ?? `Plugin is ${record.status}` };
    }
    const check = record.instance.healthCheck;
    if (!check) return { ok: true, message: 'Plugin is active (it does not implement a health check)' };
    try {
      const result = await this.invoke(record.manifest!.id, 'healthCheck', (o) => check.call(record.instance, o), {
        timeoutMs: 20_000,
      });
      return { ok: !!result?.ok, message: result?.message };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  clearCache(id: string): number {
    const manifest = this.requireManifest(this.requireById(id));
    return clearPluginCache(this.opts.db, manifest.id);
  }
}
