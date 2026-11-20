import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { EventBus } from '../src/lib/events.js';
import { PluginManager } from '../src/plugins/manager.js';
import { SECRET_MASK } from '../src/plugins/settings.js';
import { PLUGINS_DIR, silentLogger, tempDir, waitFor, writeFiles } from './helpers/harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function manifest(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, capabilities: ['metadata'], ...extra }, null, 2);
}

const metadataPlugin = (title: string) => `
import type { PluginFactory } from '@streamora/plugin-sdk';
const create: PluginFactory = (ctx) => ({
  metadata: {
    async match(req) {
      return { kind: req.kind, title: ${JSON.stringify(title)} + String(ctx.settings.suffix ?? '') };
    },
  },
  async healthCheck() { return { ok: true, message: 'healthy' }; },
});
export default create;
`;

async function setup(files: Record<string, string>, options: { hotReload?: boolean; env?: NodeJS.ProcessEnv; pluginsDir?: string } = {}) {
  const root = tempDir();
  const pluginsDir = options.pluginsDir ?? path.join(root, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  writeFiles(pluginsDir, files);
  const database = openDatabase(':memory:');
  const events = new EventBus();
  const manager = new PluginManager({
    db: database.db,
    log: silentLogger(),
    events,
    pluginsDir,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'data', 'cache'),
    hotReload: options.hotReload ?? false,
    callTimeoutMs: 5_000,
    serverVersion: 'test',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    env: options.env ?? {},
  });
  await manager.init();
  cleanups.push(async () => {
    await manager.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, pluginsDir, events, root };
}

const signal = () => ({ signal: new AbortController().signal });

describe('PluginManager', () => {
  it('discovers, bundles and activates a TypeScript plugin', async () => {
    const { manager } = await setup({
      'hello/manifest.json': manifest('hello'),
      'hello/index.ts': metadataPlugin('Hello'),
    });
    expect(manager.list()).toMatchObject([{ id: 'hello', status: 'active', enabled: true, hasHealthCheck: true }]);

    const [provider] = manager.getActive('metadata');
    const result = await manager.invoke('hello', 'match', (o) =>
      provider!.impl.match({ kind: 'movie', title: 'x', language: 'en-US', libraryType: 'movies', externalIds: {}, filePaths: [], current: { kind: 'movie' } }, o),
    );
    expect(result?.title).toBe('Hello');
    expect(await manager.healthCheck('hello')).toEqual({ ok: true, message: 'healthy' });
  });

  it('reports invalid manifests and ignores _-prefixed folders', async () => {
    const { manager } = await setup({
      'broken/manifest.json': '{ "id": "Broken!", ',
      'bad-schema/manifest.json': manifest('bad-schema', { capabilities: ['teleport'] }),
      'no-entry/manifest.json': manifest('no-entry'),
      '_template-plugin/manifest.json': manifest('template'),
      '_template-plugin/index.ts': metadataPlugin('Template'),
    });
    const list = manager.list();
    expect(list.map((p) => p.id).sort()).toEqual(['bad-schema', 'broken', 'no-entry']);
    expect(list.every((p) => p.status === 'invalid')).toBe(true);
    expect(list.find((p) => p.id === 'broken')!.errors[0]).toMatch(/not valid JSON/);
    expect(list.find((p) => p.id === 'bad-schema')!.errors[0]).toMatch(/capabilities\.0/);
    expect(list.find((p) => p.id === 'no-entry')!.errors[0]).toMatch(/entry file "index.ts" does not exist/);
  });

  it('waits for required settings, then activates with a fresh context', async () => {
    const { manager } = await setup({
      'secretive/manifest.json': manifest('secretive', {
        settings: [
          { key: 'token', type: 'secret', label: 'Token', required: true },
          { key: 'suffix', type: 'string', label: 'Suffix', default: '' },
        ],
      }),
      'secretive/index.ts': metadataPlugin('Secret'),
    });
    expect(manager.get('secretive')).toMatchObject({ status: 'needs_config', missingSettings: ['token'] });
    expect(manager.getActive('metadata')).toHaveLength(0);

    const details = await manager.updateSettings('secretive', { token: 'abc', suffix: '!' });
    expect(details.status).toBe('active');
    expect(details.settings.values).toEqual({ token: SECRET_MASK, suffix: '!' });

    // Sending the mask back keeps the stored secret.
    expect((await manager.updateSettings('secretive', { token: SECRET_MASK })).status).toBe('active');
    await expect(manager.updateSettings('secretive', { token: 42 })).rejects.toMatchObject({ statusCode: 400 });

    const [provider] = manager.getActive('metadata');
    const result = await provider!.impl.match(
      { kind: 'movie', title: 'x', language: 'en', libraryType: 'movies', externalIds: {}, filePaths: [], current: { kind: 'movie' } },
      signal(),
    );
    expect(result?.title).toBe('Secret!');
  });

  it('marks plugins whose instance does not implement declared capabilities as errored', async () => {
    const { manager } = await setup({
      'liar/manifest.json': manifest('liar', { capabilities: ['metadata', 'stream_resolver'] }),
      'liar/index.ts': metadataPlugin('Liar'),
      'thrower/manifest.json': manifest('thrower'),
      'thrower/index.ts': `export default () => { throw new Error('boom at startup'); };`,
      'not-a-factory/manifest.json': manifest('not-a-factory'),
      'not-a-factory/index.ts': `export default { metadata: {} };`,
    });
    expect(manager.get('liar')).toMatchObject({ status: 'error' });
    expect(manager.get('liar').error).toMatch(/stream_resolver/);
    expect(manager.get('thrower').error).toMatch(/boom at startup/);
    expect(manager.get('not-a-factory').error).toMatch(/export default/);
  });

  it('enables, disables and re-orders plugins', async () => {
    const { manager } = await setup({
      'alpha/manifest.json': manifest('alpha', { priority: 10 }),
      'alpha/index.ts': metadataPlugin('A'),
      'beta/manifest.json': manifest('beta', { priority: 20, enabledByDefault: false }),
      'beta/index.ts': metadataPlugin('B'),
    });
    expect(manager.get('beta').status).toBe('disabled');
    expect(manager.getActive('metadata').map((p) => p.id)).toEqual(['alpha']);

    await manager.setEnabled('beta', true);
    expect(manager.getActive('metadata').map((p) => p.id)).toEqual(['alpha', 'beta']);

    await manager.setPriority('beta', 5);
    expect(manager.getActive('metadata').map((p) => p.id)).toEqual(['beta', 'alpha']);

    await manager.setEnabled('alpha', false);
    expect(manager.get('alpha').status).toBe('disabled');
    expect(manager.getActive('metadata').map((p) => p.id)).toEqual(['beta']);
    await expect(manager.invoke('alpha', 'x', async () => 1)).rejects.toThrow(/not active/);
  });

  it('reloads changed code on demand', async () => {
    const { manager, pluginsDir } = await setup({
      'swap/manifest.json': manifest('swap'),
      'swap/index.ts': metadataPlugin('Before'),
    });
    fs.writeFileSync(path.join(pluginsDir, 'swap', 'index.ts'), metadataPlugin('After'));
    fs.writeFileSync(path.join(pluginsDir, 'swap', 'manifest.json'), manifest('swap', { version: '1.1.0' }));
    const details = await manager.reload('swap');
    expect(details).toMatchObject({ status: 'active', version: '1.1.0' });
    const [provider] = manager.getActive('metadata');
    const result = await provider!.impl.match(
      { kind: 'movie', title: 'x', language: 'en', libraryType: 'movies', externalIds: {}, filePaths: [], current: { kind: 'movie' } },
      signal(),
    );
    expect(result?.title).toBe('After');
  });

  it('gives every activation a fresh module and never deletes bundles at runtime', async () => {
    const { manager, root } = await setup({
      'stateful/manifest.json': manifest('stateful', { settings: [{ key: 'label', type: 'string', label: 'Label' }] }),
      'stateful/index.ts': `
        let activations = 0; // module-level state
        export default () => {
          activations++;
          return { metadata: { async match(req) { return { kind: req.kind, title: String(activations) }; } } };
        };`,
    });
    const title = async () =>
      (await manager.getActive('metadata')[0]!.impl.match(
        { kind: 'movie', title: 'x', language: 'en', libraryType: 'movies', externalIds: {}, filePaths: [], current: { kind: 'movie' } },
        signal(),
      ))?.title;

    expect(await title()).toBe('1');
    const bundles = () => fs.readdirSync(path.join(root, 'data', 'cache', 'plugins'));
    const before = bundles();

    await manager.updateSettings('stateful', { label: 'changed' }); // same code, new activation
    expect(await title()).toBe('1');
    expect(bundles()).toEqual(before);
  });

  it('hot-reloads plugins when files change on disk', async () => {
    const { manager, pluginsDir } = await setup(
      { 'live/manifest.json': manifest('live'), 'live/index.ts': metadataPlugin('v1') },
      { hotReload: true },
    );
    const titleNow = async () => {
      const provider = manager.getActive('metadata').find((p) => p.id === 'live');
      if (!provider) return undefined;
      const r = await provider.impl.match(
        { kind: 'movie', title: 'x', language: 'en', libraryType: 'movies', externalIds: {}, filePaths: [], current: { kind: 'movie' } },
        signal(),
      );
      return r?.title;
    };
    expect(await titleNow()).toBe('v1');

    fs.writeFileSync(path.join(pluginsDir, 'live', 'index.ts'), metadataPlugin('v2'));
    await waitFor(async () => (await titleNow()) === 'v2', 15_000);

    // New plugin folders are picked up too...
    writeFiles(pluginsDir, { 'newcomer/manifest.json': manifest('newcomer'), 'newcomer/index.ts': metadataPlugin('New') });
    await waitFor(() => manager.list().find((p) => p.id === 'newcomer')?.status === 'active', 15_000);

    // ...and removed ones are unloaded.
    fs.rmSync(path.join(pluginsDir, 'newcomer'), { recursive: true, force: true });
    await waitFor(() => !manager.list().some((p) => p.id === 'newcomer'), 15_000);
  });

  it('loads the built-in plugins (TMDB waits for an API key)', async () => {
    const { manager } = await setup({}, { pluginsDir: PLUGINS_DIR });
    const byId = Object.fromEntries(manager.list().map((p) => [p.id, p]));
    expect(byId['tmdb-metadata']).toMatchObject({ status: 'needs_config', missingSettings: ['apiKey'] });
    expect(byId['local-nfo-agent']).toMatchObject({ status: 'active' });
    expect(byId['subtitle-manager']).toMatchObject({ status: 'active' });
    expect(byId['_template-plugin']).toBeUndefined();
    // Priority order: NFO (10) before TMDB (50).
    expect(manager.getActive('metadata').map((p) => p.id)).toEqual(['local-nfo-agent']);
  });

  it('activates TMDB when the key comes from the environment', async () => {
    const { manager } = await setup({}, { pluginsDir: PLUGINS_DIR, env: { TMDB_API_KEY: 'test-key' } });
    expect(manager.get('tmdb-metadata')).toMatchObject({ status: 'active' });
    expect(manager.get('tmdb-metadata').settings.sources.apiKey).toBe('env');
    expect(manager.getActive('metadata').map((p) => p.id)).toEqual(['local-nfo-agent', 'tmdb-metadata']);
  });
});
