import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/db/client.js';
import { EventBus } from '../src/lib/events.js';
import { PluginManager } from '../src/plugins/manager.js';
import { MetadataService } from '../src/plugins/services/metadata.js';
import { silentLogger, tempDir, writeFiles } from './helpers/harness.js';

const manifest = (id: string, priority: number) =>
  JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, capabilities: ['metadata'], priority });

// A "local" agent: knows the title, an IMDb id and a local poster.
const localAgent = `
export default () => ({
  metadata: {
    async match(req) {
      return {
        kind: req.kind,
        title: 'Local Title',
        externalIds: { imdb: 'tt0133093' },
        artwork: { poster: '/media/movies/The Matrix (1999)/poster.jpg' },
      };
    },
    async getSeason(req) {
      return { seasonNumber: req.seasonNumber, episodes: [{ seasonNumber: 1, episodeNumber: 1, title: 'Local Ep 1' }] };
    },
  },
});`;

// A "remote" agent: echoes the ids it received, fills other fields, and returns some junk.
const remoteAgent = `
export default () => ({
  metadata: {
    async match(req) {
      return {
        kind: req.kind,
        title: 'Remote Title',
        overview: 'received ' + JSON.stringify(req.externalIds) + ' current=' + req.current.title,
        year: '1999',
        rating: 11,
        genres: ['Action', 'Action', '', 'Sci-Fi'],
        artwork: { poster: 'https://img.example/p.jpg', backdrop: 'https://img.example/b.jpg', logo: 'relative/logo.png' },
        externalIds: { tmdb: 603, imdb: 'tt9999999' },
      };
    },
    async getSeason(req) {
      return {
        seasonNumber: req.seasonNumber,
        title: 'Season 1',
        episodes: [
          { seasonNumber: 1, episodeNumber: 1, title: 'Remote Ep 1', overview: 'First' },
          { seasonNumber: 1, episodeNumber: 2, title: 'Remote Ep 2' },
          { seasonNumber: 'x', episodeNumber: 3 },
        ],
      };
    },
    async search(q) {
      return [{ kind: 'movie', title: q.query + ' (remote)', year: 1999, externalIds: { tmdb: '603' } }, { title: '' }];
    },
  },
});`;

const brokenAgent = `export default () => ({ metadata: { async match() { throw new Error('upstream down'); } } });`;

let root: string;
let database: DatabaseHandle;
let manager: PluginManager;
let metadata: MetadataService;

beforeAll(async () => {
  root = tempDir();
  const pluginsDir = path.join(root, 'plugins');
  writeFiles(pluginsDir, {
    'local/manifest.json': manifest('local', 10),
    'local/index.ts': localAgent,
    'remote/manifest.json': JSON.stringify({ ...JSON.parse(manifest('remote', 50)), main: 'index.js' }),
    'remote/index.js': remoteAgent,
    'broken/manifest.json': JSON.stringify({ ...JSON.parse(manifest('broken', 30)), main: 'index.js' }),
    'broken/index.js': brokenAgent,
  });

  database = openDatabase(':memory:');
  manager = new PluginManager({
    db: database.db,
    log: silentLogger(),
    events: new EventBus(),
    pluginsDir,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'data', 'cache'),
    hotReload: false,
    callTimeoutMs: 5_000,
    serverVersion: 'test',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    env: {},
  });
  await manager.init();
  metadata = new MetadataService(manager, silentLogger());
});

afterAll(async () => {
  await manager.close();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const input = {
  kind: 'movie' as const,
  title: 'The Matrix',
  year: 1999,
  language: 'en-US',
  libraryType: 'movies' as const,
  filePaths: ['/media/movies/The Matrix (1999)/The Matrix (1999).mkv'],
};

describe('MetadataService', () => {
  it('runs providers in priority order, filling gaps and passing ids forward', async () => {
    expect(metadata.providers().map((p) => p.id)).toEqual(['local', 'broken', 'remote']);
    const outcome = await metadata.match(input);

    expect(outcome.sources).toEqual(['local', 'remote']);
    expect(outcome.errors).toEqual([{ provider: 'broken', error: 'upstream down' }]);
    expect(outcome.metadata).toMatchObject({
      kind: 'movie',
      title: 'Local Title', // higher priority wins
      year: 1999, // coerced from "1999"
      rating: 10, // clamped
      genres: ['Action', 'Sci-Fi'], // de-duplicated, empty dropped
      artwork: {
        poster: '/media/movies/The Matrix (1999)/poster.jpg', // local art wins
        backdrop: 'https://img.example/b.jpg', // remote fills the gap
      },
      externalIds: { imdb: 'tt0133093', tmdb: '603' }, // ids merged, first provider wins conflicts
    });
    expect(outcome.metadata?.artwork?.logo).toBeUndefined(); // relative path rejected
    // The remote agent saw the IMDb id and the merged state from the local agent.
    expect(outcome.metadata?.overview).toBe('received {"imdb":"tt0133093"} current=Local Title');
  });

  it('honours a library-specific agent list', async () => {
    const outcome = await metadata.match(input, { agents: ['remote'] });
    expect(outcome.sources).toEqual(['remote']);
    expect(outcome.metadata?.title).toBe('Remote Title');
  });

  it('merges season and episode metadata', async () => {
    const outcome = await metadata.getSeason({
      show: { title: 'Show', externalIds: {} },
      seasonNumber: 1,
      language: 'en-US',
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, filePaths: [] },
        { seasonNumber: 1, episodeNumber: 2, filePaths: [] },
      ],
    });
    expect(outcome.sources).toEqual(['local', 'remote']);
    expect(outcome.season).toEqual({
      seasonNumber: 1,
      title: 'Season 1',
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, title: 'Local Ep 1', overview: 'First' },
        { seasonNumber: 1, episodeNumber: 2, title: 'Remote Ep 2' },
      ],
    });
  });

  it('aggregates search results and drops invalid entries', async () => {
    const { results } = await metadata.search({ kind: 'movie', query: 'Matrix', language: 'en-US' });
    expect(results).toEqual([
      { provider: 'remote', kind: 'movie', title: 'Matrix (remote)', year: 1999, externalIds: { tmdb: '603' } },
    ]);
  });
});
