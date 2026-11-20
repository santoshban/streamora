import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ScanCompletedEvent } from '@streamora/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { episodes, libraries, mediaFiles, mediaItems, seasons, subtitleTracks, type Library } from '../src/db/schema.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import type { MediaProbe } from '../src/media/probe.js';
import type { ScanSummary } from '../src/scanner/scanner.js';
import { createServices, type Services } from '../src/services.js';
import { PLUGINS_DIR, silentLogger, tempDir, waitFor, writeFiles } from './helpers/harness.js';

declare global {
  // eslint-disable-next-line no-var
  var __scanEvents: ScanCompletedEvent[] | undefined;
  // eslint-disable-next-line no-var
  var __matchCalls: Array<{ title: string; externalIds: Record<string, string | undefined> }> | undefined;
}

let root: string;
let media: string;
let services: Services;
let app: FastifyInstance;
let probeCalls: string[] = [];

const fakeProbe = async (file: string): Promise<MediaProbe> => {
  probeCalls.push(file);
  if (file.includes('corrupt')) throw new Error('Invalid data found when processing input');
  return {
    container: 'mkv',
    durationSeconds: 1500,
    bitrate: 6_000_000,
    startTimeSeconds: 0,
    videoCodec: 'h264',
    videoProfile: 'High',
    width: 1920,
    height: 1080,
    frameRate: 23.976,
    bitDepth: 8,
    resolution: '1080p',
    hdr: null,
    audioCodec: 'aac',
    audioChannels: 2,
    streams: [
      { index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080 },
      { index: 1, type: 'audio', codec: 'aac', channels: 2, language: 'eng', default: true },
    ],
  };
};

beforeAll(async () => {
  root = tempDir();
  media = path.join(root, 'media');
  const pluginsDir = path.join(root, 'plugins');
  // Real subtitle plugin (sidecar discovery) + a fake metadata/post-scan plugin.
  fs.cpSync(path.join(PLUGINS_DIR, 'subtitle-manager'), path.join(pluginsDir, 'subtitle-manager'), {
    recursive: true,
    filter: (src) => !/[\\/](test|node_modules)$/.test(src),
  });
  writeFiles(pluginsDir, {
    'fake-meta/manifest.json': JSON.stringify({
      id: 'fake-meta',
      name: 'Fake metadata',
      version: '1.0.0',
      apiVersion: 1,
      capabilities: ['metadata', 'post_scan'],
    }),
    'fake-meta/index.ts': `
      export default () => ({
        metadata: {
          async match(req) {
            (globalThis.__matchCalls ??= []).push({ title: req.title, externalIds: { ...req.externalIds } });
            if (/unknown/i.test(req.title)) return null;
            return {
              kind: req.kind,
              title: 'Meta ' + req.title,
              year: req.year,
              overview: 'About ' + req.title,
              genres: ['Drama'],
              artwork: { poster: 'https://img.example/' + encodeURIComponent(req.title) + '.jpg' },
              externalIds: { tmdb: '100', ...req.externalIds },
            };
          },
          async getSeason(req) {
            return {
              seasonNumber: req.seasonNumber,
              title: 'Season ' + req.seasonNumber,
              episodes: req.episodes.flatMap((e) => [e.episodeNumber, e.episodeNumber + 1]).map((n) => ({
                seasonNumber: req.seasonNumber, episodeNumber: n, title: 'Episode ' + n,
              })),
            };
          },
        },
        postScan: { async onScanComplete(event) { (globalThis.__scanEvents ??= []).push(event); } },
      });`,
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DIR: path.join(root, 'data'),
    PLUGINS_DIR: pluginsDir,
    PLUGINS_HOT_RELOAD: 'false',
    SCAN_ON_STARTUP: 'false',
    SCAN_INTERVAL_MINUTES: '0',
  });
  services = await createServices(config, silentLogger(), { ffmpeg: { ffmpeg: null, ffprobe: null }, probe: fakeProbe });
  app = await buildApp(services);
  await services.plugins.init();
});

afterAll(async () => {
  await app.close();
  await services.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  probeCalls = [];
  globalThis.__scanEvents = [];
  globalThis.__matchCalls = [];
});

function createLibrary(name: string, type: Library['type'], folder: string, watch = false): Library {
  fs.mkdirSync(folder, { recursive: true });
  return services.db.insert(libraries).values({ name, type, paths: [folder], watch }).returning().get();
}

async function scan(lib: Library, refreshMetadata = false): Promise<ScanSummary> {
  services.scans.requestScan(lib.id, { refreshMetadata });
  await services.scans.idle(lib.id);
  const last = services.scans.status(lib.id).last;
  if (!last || last.error || last.cancelled) throw new Error(last?.error ?? 'scan did not complete');
  return last as ScanSummary;
}

let adminSession: Record<string, string> | undefined;
/** Session cookie of the first (admin) profile, created on first use. */
async function admin(): Promise<Record<string, string>> {
  if (adminSession) return adminSession;
  const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Owner' } });
  adminSession = { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return adminSession;
}

const itemsOf = (lib: Library) => services.db.select().from(mediaItems).where(eq(mediaItems.libraryId, lib.id)).orderBy(mediaItems.sortTitle).all();
const filesOf = (lib: Library) => services.db.select().from(mediaFiles).where(eq(mediaFiles.libraryId, lib.id)).orderBy(mediaFiles.path).all();

describe('movie library', () => {
  let lib: Library;
  let dir: string;

  beforeAll(() => {
    dir = path.join(media, 'Movies');
    writeFiles(dir, {
      'The Matrix (1999)/The Matrix (1999) - 1080p.mkv': 'a',
      'The Matrix (1999)/The.Matrix.1999.2160p.UHD.BluRay.mkv': 'bb',
      'The Matrix (1999)/The Matrix (1999) - 1080p.en.srt': '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
      'Inception.2010.720p.WEB-DL.mkv': 'c',
      'Inception.2010-sample.mkv': 'x',
      'Extras/Behind the scenes.mkv': 'x',
      'Unknown Film (2001)/Unknown Film (2001).mkv': 'd',
      'Broken (2005)/corrupt.mkv': 'e',
      'notes.txt': 'not a video',
    });
    lib = createLibrary('Movies', 'movies', dir);
  });

  it('finds movies, groups versions, skips extras and samples', async () => {
    const summary = await scan(lib);
    expect(summary.added).toBe(4);
    expect(summary.files).toMatchObject({ added: 5, removed: 0 });

    const items = itemsOf(lib);
    expect(items.map((i) => i.matchKey).sort()).toEqual(['broken|2005', 'inception|2010', 'the matrix|1999', 'unknown film|2001']);

    const matrix = items.find((i) => i.matchKey === 'the matrix|1999')!;
    const versions = filesOf(lib).filter((f) => f.mediaItemId === matrix.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.resolution).sort()).toEqual(['1080p', '1080p']); // probe wins over the name
    expect(versions.find((v) => v.path.includes('2160p'))?.source).toBe('BluRay');
    expect(matrix.folderPath).toBe(path.join(dir, 'The Matrix (1999)'));

    const inception = items.find((i) => i.matchKey === 'inception|2010')!;
    expect(inception.folderPath).toBeNull();
  });

  it('applies metadata from plugins and records unmatched items', () => {
    const items = itemsOf(lib);
    const matrix = items.find((i) => i.matchKey === 'the matrix|1999')!;
    expect(matrix).toMatchObject({
      title: 'Meta The Matrix',
      sortTitle: 'meta the matrix',
      year: 1999,
      overview: 'About The Matrix',
      genres: ['Drama'],
      poster: 'https://img.example/The%20Matrix.jpg',
      metadataSources: ['fake-meta'],
    });
    expect(matrix.externalIds.tmdb).toBe('100');

    const unknown = items.find((i) => i.matchKey === 'unknown film|2001')!;
    expect(unknown.title).toBe('Unknown Film');
    expect(unknown.metadataSources).toEqual([]);
    expect(unknown.metadataUpdatedAt).not.toBeNull();
  });

  it('stores probe failures without failing the scan', () => {
    const broken = filesOf(lib).find((f) => f.path.includes('corrupt'))!;
    expect(broken.probeError).toMatch(/Invalid data/);
    expect(broken.probedAt).not.toBeNull();
  });

  it('discovers sidecar subtitles through the subtitle plugin', () => {
    const file = filesOf(lib).find((f) => f.path.endsWith('The Matrix (1999) - 1080p.mkv'))!;
    const tracks = services.db.select().from(subtitleTracks).where(eq(subtitleTracks.mediaFileId, file.id)).all();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ source: 'sidecar', language: 'eng', providerId: 'subtitle-manager', renderable: true });
  });

  it('notifies post-scan plugins', async () => {
    writeFiles(dir, { 'Heat (1995)/Heat (1995).mkv': 'h' });
    await scan(lib);
    await waitFor(() => globalThis.__scanEvents!.length > 0);
    const event = globalThis.__scanEvents![0]!;
    expect(event.library).toMatchObject({ id: lib.id, type: 'movies' });
    expect(event.added.map((a) => a.title)).toEqual(['Meta Heat']);
    expect(event.added[0]!.files[0]!.streams).toHaveLength(2);
  });

  it('rescans unchanged folders without probing or re-matching', async () => {
    // Plugins are reloaded on every server start: that alone must not trigger re-matching.
    await services.plugins.reload('fake-meta');
    globalThis.__matchCalls = [];
    const summary = await scan(lib);
    expect(summary).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(summary.files.unchanged).toBe(6);
    expect(probeCalls).toEqual([]);
    expect(globalThis.__matchCalls).toEqual([]);
  });

  it('re-probes changed files and removes deleted ones', async () => {
    fs.writeFileSync(path.join(dir, 'Inception.2010.720p.WEB-DL.mkv'), 'changed content');
    fs.rmSync(path.join(dir, 'The Matrix (1999)', 'The.Matrix.1999.2160p.UHD.BluRay.mkv'));
    const summary = await scan(lib);
    expect(summary.files).toMatchObject({ updated: 1, removed: 1 });
    expect(probeCalls).toHaveLength(1);
    expect(itemsOf(lib).some((i) => i.matchKey === 'the matrix|1999')).toBe(true);

    fs.rmSync(path.join(dir, 'Heat (1995)'), { recursive: true });
    const second = await scan(lib);
    expect(second.removed).toBe(1);
    expect(itemsOf(lib).some((i) => i.matchKey === 'heat|1995')).toBe(false);
  });

  it('refreshes metadata on demand and honours "Fix match" locks', async () => {
    const matrix = itemsOf(lib).find((i) => i.matchKey === 'the matrix|1999')!;
    const cookie = await admin();

    const fixed = await app.inject({
      method: 'POST',
      url: `/api/items/${matrix.id}/match`,
      cookies: cookie,
      payload: { externalIds: { TMDB: '603' } },
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().item).toMatchObject({ locked: true, externalIds: { tmdb: '603' }, title: 'Meta The Matrix' });
    expect(globalThis.__matchCalls!.at(-1)).toEqual({ title: 'The Matrix', externalIds: { tmdb: '603' } });

    // A library-wide refresh keeps the pinned ids.
    globalThis.__matchCalls = [];
    await scan(lib, true);
    expect(globalThis.__matchCalls.find((c) => c.title === 'Meta The Matrix')?.externalIds.tmdb).toBe('603');

    const rematch = await app.inject({ method: 'POST', url: `/api/items/${matrix.id}/refresh`, cookies: cookie, payload: { rematch: true } });
    expect(rematch.json().item).toMatchObject({ locked: false, externalIds: { tmdb: '100' }, title: 'Meta The Matrix' });
  });

  it('keeps items when a library folder disappears (unmounted drive)', async () => {
    const backup = path.join(root, 'movies-backup');
    fs.renameSync(dir, backup);
    fs.mkdirSync(dir); // empty mount point
    const before = itemsOf(lib).length;
    const summary = await scan(lib);
    expect(summary.removed).toBe(0);
    expect(summary.files.missing).toBeGreaterThan(0);
    expect(summary.errors.join(' ')).toMatch(/empty/);
    expect(itemsOf(lib)).toHaveLength(before);
    expect(filesOf(lib).every((f) => f.missing)).toBe(true);

    fs.rmSync(dir, { recursive: true });
    fs.renameSync(backup, dir);
    await scan(lib);
    expect(filesOf(lib).some((f) => f.missing)).toBe(false);
  });
});

describe('show libraries', () => {
  it('builds shows, seasons and episodes (multi-episode, bare names, loose files)', async () => {
    const dir = path.join(media, 'Shows');
    writeFiles(dir, {
      'Breaking Bad (2008)/Season 1/Breaking.Bad.S01E01.720p.mkv': 'a',
      'Breaking Bad (2008)/Season 1/Breaking.Bad.S01E02E03.mkv': 'b',
      'Breaking Bad (2008)/Season 2/05 - Breakage.mkv': 'c',
      'Breaking Bad (2008)/Specials/Breaking Bad - S00E01 - Pilot Promo.mkv': 'd',
      'Breaking Bad (2008)/tvshow.nfo': '<tvshow><title>Breaking Bad</title></tvshow>',
      'Loose.Show.S03E04.mkv': 'e',
      'Mystery Folder/random clip.mkv': 'f',
    });
    const lib = createLibrary('Shows', 'shows', dir);
    const summary = await scan(lib);
    expect(summary.added).toBe(2);
    expect(summary.unidentified).toEqual([path.join(dir, 'Mystery Folder', 'random clip.mkv')]);

    const shows = itemsOf(lib);
    const bb = shows.find((s) => s.matchKey === 'breaking bad|2008')!;
    expect(bb).toMatchObject({ kind: 'show', title: 'Meta Breaking Bad', folderPath: path.join(dir, 'Breaking Bad (2008)') });
    expect(shows.find((s) => s.matchKey === 'loose show|')).toBeDefined();

    const bbSeasons = services.db.select().from(seasons).where(eq(seasons.showId, bb.id)).orderBy(seasons.seasonNumber).all();
    expect(bbSeasons.map((s) => [s.seasonNumber, s.title])).toEqual([
      [0, 'Season 0'],
      [1, 'Season 1'],
      [2, 'Season 2'],
    ]);
    const eps = services.db
      .select()
      .from(episodes)
      .where(eq(episodes.showId, bb.id))
      .orderBy(episodes.seasonNumber, episodes.episodeNumber)
      .all();
    expect(eps.map((e) => [e.seasonNumber, e.episodeNumber, e.episodeNumberEnd, e.title])).toEqual([
      [0, 1, null, 'Episode 1'],
      [1, 1, null, 'Episode 1'],
      [1, 2, 3, 'Episode 2 / Episode 3'],
      [2, 5, null, 'Episode 5'],
    ]);
    const files = filesOf(lib).filter((f) => f.mediaItemId === bb.id);
    expect(files.every((f) => f.episodeId !== null)).toBe(true);
  });

  it('uses absolute numbering in anime libraries', async () => {
    const dir = path.join(media, 'Anime');
    writeFiles(dir, {
      'Frieren/[SubsPlease] Sousou no Frieren - 05 (1080p) [A1B2C3D4].mkv': 'a',
      'Frieren/Season 2/[SubsPlease] Sousou no Frieren - 03 (1080p).mkv': 'b',
    });
    const lib = createLibrary('Anime', 'anime', dir);
    await scan(lib);
    const [show] = itemsOf(lib);
    expect(show).toMatchObject({ kind: 'show', matchKey: 'frieren|' });
    const eps = services.db.select().from(episodes).where(eq(episodes.showId, show!.id)).orderBy(episodes.seasonNumber).all();
    expect(eps.map((e) => [e.seasonNumber, e.episodeNumber, e.absoluteNumber])).toEqual([
      [1, 5, 5],
      [2, 3, null],
    ]);
  });
});

describe('scan API and incremental updates', () => {
  let cookie: Record<string, string>;

  beforeAll(async () => {
    cookie = await admin();
  });

  it('rejects library folders that overlap another library', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      cookies: cookie,
      payload: { name: 'Overlap', type: 'movies', paths: [path.join(media, 'Movies', 'The Matrix (1999)')] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toMatch(/overlaps/);
  });

  it('runs scans through the API and reports progress', async () => {
    const dir = path.join(media, 'Docs');
    writeFiles(dir, { 'Planet Earth (2006)/Planet Earth (2006).mkv': 'a' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      cookies: cookie,
      payload: { name: 'Docs', type: 'movies', paths: [dir], watch: false },
    });
    const id = created.json().library.id as number;

    const progress: string[] = [];
    const unsubscribe = services.events.subscribe((e) => {
      if (e.type === 'scan.progress') progress.push((e.data as { phase: string }).phase);
    });
    const started = await app.inject({ method: 'POST', url: `/api/libraries/${id}/scan`, cookies: cookie, payload: {} });
    expect(started.statusCode).toBe(202);
    await services.scans.idle(id);
    unsubscribe();

    const status = await app.inject({ method: 'GET', url: `/api/libraries/${id}/scan`, cookies: cookie });
    expect(status.json().scan).toMatchObject({ state: 'idle', last: { kind: 'full', added: 1 } });
    expect(progress).toEqual(expect.arrayContaining(['discovering', 'probing', 'saving', 'metadata', 'subtitles']));

    const list = await app.inject({ method: 'GET', url: `/api/libraries/${id}`, cookies: cookie });
    expect(list.json().library.counts).toEqual({ movies: 1, shows: 0 });
  });

  it('applies watcher batches as partial scans (add, then delete → missing)', async () => {
    const dir = path.join(media, 'Partial');
    const lib = createLibrary('Partial', 'movies', dir);
    await scan(lib);
    writeFiles(dir, { 'Alien (1979)/Alien (1979).mkv': 'a', 'Alien (1979)/Alien (1979).srt': '1\n00:00:01,000 --> 00:00:02,000\nx\n' });

    services.scans.requestPartial(lib.id, [path.join(dir, 'Alien (1979)')]);
    await services.scans.idle(lib.id);
    const alien = itemsOf(lib).find((i) => i.matchKey === 'alien|1979')!;
    expect(alien.title).toBe('Meta Alien');
    const file = filesOf(lib)[0]!;
    expect(services.db.select().from(subtitleTracks).where(eq(subtitleTracks.mediaFileId, file.id)).all()).toHaveLength(1);

    fs.rmSync(path.join(dir, 'Alien (1979)', 'Alien (1979).mkv'));
    services.scans.requestPartial(lib.id, [path.join(dir, 'Alien (1979)', 'Alien (1979).mkv')]);
    await services.scans.idle(lib.id);
    expect(filesOf(lib)[0]!.missing).toBe(true);
    expect(itemsOf(lib)).toHaveLength(1); // kept until a full scan confirms

    await scan(lib);
    expect(itemsOf(lib)).toHaveLength(0);
  });

  it('cancels a running scan', async () => {
    const dir = path.join(media, 'Big');
    writeFiles(dir, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Film ${i} (2000)/Film ${i} (2000).mkv`, 'x'])));
    const lib = createLibrary('Big', 'movies', dir);
    services.scans.requestScan(lib.id);
    expect(services.scans.cancel(lib.id)).toBe(true);
    await services.scans.idle(lib.id);
    expect(services.scans.status(lib.id).last).toMatchObject({ cancelled: true });
  });

  it('picks up new files through the file watcher', async () => {
    const dir = path.join(media, 'Watched');
    fs.mkdirSync(dir, { recursive: true });
    const created = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      cookies: cookie,
      payload: { name: 'Watched', type: 'movies', paths: [dir], watch: true },
    });
    const id = created.json().library.id as number;
    services.start(); // watchers for existing libraries; startup scan is off in this config
    await services.scans.idle(id);
    await waitFor(() => services.scans.status(id).watching, 5000);
    // chokidar needs a moment to attach before the first event is reliable.
    await new Promise((r) => setTimeout(r, 500));

    writeFiles(dir, { 'Up (2009)/Up (2009).mkv': 'up' });
    const item = await waitFor(
      () =>
        services.db
          .select()
          .from(mediaItems)
          .where(and(eq(mediaItems.libraryId, id), eq(mediaItems.matchKey, 'up|2009')))
          .get(),
      25_000,
    );
    expect(item!.title).toBe('Meta Up');
  }, 40_000);
});
