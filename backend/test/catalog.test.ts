import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isKidsRating } from '../src/catalog/access.js';
import { isComplete, pickDefaultFile } from '../src/catalog/catalog.js';
import { loadConfig } from '../src/config.js';
import { libraries } from '../src/db/schema.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import type { MediaProbe } from '../src/media/probe.js';
import { createServices, type Services } from '../src/services.js';
import { silentLogger, tempDir, writeFiles } from './helpers/harness.js';

let root: string;
let media: string;
let services: Services;
let app: FastifyInstance;
let admin: Record<string, string>;
let kid: Record<string, string>;
const fetched: string[] = [];

const probe = async (file: string): Promise<MediaProbe> => ({
  container: 'mkv',
  durationSeconds: 3000,
  bitrate: 5_000_000,
  startTimeSeconds: 0,
  videoCodec: file.includes('2160p') ? 'hevc' : 'h264',
  videoProfile: 'High',
  width: file.includes('2160p') ? 3840 : 1920,
  height: file.includes('2160p') ? 2160 : 1080,
  frameRate: 24,
  bitDepth: 8,
  resolution: file.includes('2160p') ? '4K' : '1080p',
  hdr: file.includes('2160p') ? 'HDR10' : null,
  audioCodec: 'aac',
  audioChannels: 2,
  streams: [
    { index: 0, type: 'video', codec: 'h264' },
    { index: 1, type: 'audio', codec: 'aac', channels: 2, default: true },
  ],
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (url.endsWith('.svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } });
  return new Response(PNG, { headers: { 'content-type': 'image/png' } });
}) as typeof fetch;

const cookieOf = (res: LightMyRequestResponse) => ({ [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value });
const get = (url: string, cookies = admin) => app.inject({ method: 'GET', url, cookies });

beforeAll(async () => {
  root = tempDir();
  media = path.join(root, 'media');
  const pluginsDir = path.join(root, 'plugins');
  writeFiles(pluginsDir, {
    'meta/manifest.json': JSON.stringify({ id: 'meta', name: 'Meta', version: '1.0.0', apiVersion: 1, capabilities: ['metadata'] }),
    'meta/index.ts': `
      const RATINGS = { 'Toy Town': 'G', 'Dark Night': 'R', 'Cartoon Club': 'TV-Y' };
      export default () => ({
        metadata: {
          async match(req) {
            const kidsy = RATINGS[req.title];
            return {
              kind: req.kind, title: req.title, overview: 'About ' + req.title,
              contentRating: kidsy ?? 'TV-MA',
              rating: req.title === 'Dark Night' ? 8.4 : 7,
              genres: req.title === 'Dark Night' ? ['Crime', 'Drama'] : ['Animation', 'Family'],
              cast: [{ name: req.title === 'Dark Night' ? 'Christian Bale' : 'Tom Hanks', character: 'Lead', photo: 'https://img.test/cast.png' }],
              artwork: { poster: 'https://img.test/' + encodeURIComponent(req.title) + '.png', backdrop: 'https://img.test/bd.png', logo: 'https://img.test/logo.svg' },
            };
          },
          async getSeason(req) {
            return { seasonNumber: req.seasonNumber, episodes: req.episodes.map((e) => ({ ...e, title: 'Ep ' + e.episodeNumber })) };
          },
        },
      });`,
  });
  writeFiles(media, {
    'Movies/Toy Town (1995)/Toy Town (1995) - 1080p.mkv': 'a',
    'Movies/Toy Town (1995)/Toy Town (1995) - 2160p.mkv': 'aa',
    'Movies/Dark Night (2008)/Dark Night (2008).mkv': 'b',
    'Movies/Local Art (2001)/Local Art (2001).mkv': 'c',
    'Movies/Local Art (2001)/poster.jpg': 'jpeg-bytes',
    'Shows/Cartoon Club/Season 1/Cartoon Club S01E01.mkv': 'd',
    'Shows/Cartoon Club/Season 1/Cartoon Club S01E02.mkv': 'e',
    'Shows/Cartoon Club/Season 2/Cartoon Club S02E01.mkv': 'f',
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
  services = await createServices(config, silentLogger(), { ffmpeg: { ffmpeg: null, ffprobe: null }, probe, fetchImpl });
  app = await buildApp(services);
  await services.plugins.init();

  admin = cookieOf(await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Owner' } }));
  const kidProfile = await app.inject({ method: 'POST', url: '/api/profiles', cookies: admin, payload: { name: 'Kid', isKids: true } });
  kid = cookieOf(await app.inject({ method: 'POST', url: `/api/profiles/${kidProfile.json().profile.id}/session`, payload: {} }));

  for (const [name, type, folder] of [
    ['Movies', 'movies', 'Movies'],
    ['Shows', 'shows', 'Shows'],
  ] as const) {
    const lib = services.db.insert(libraries).values({ name, type, paths: [path.join(media, folder)], watch: false }).returning().get();
    services.scans.requestScan(lib.id);
    await services.scans.idle(lib.id);
  }
  // Local artwork for "Local Art" comes from a sidecar file instead of a URL.
  const local = (await get('/api/catalog/search?q=Local')).json().items[0];
  services.database.sqlite.prepare('UPDATE media_items SET poster = ? WHERE id = ?').run(path.join(media, 'Movies', 'Local Art (2001)', 'poster.jpg'), local.id);
});

afterAll(async () => {
  await app.close();
  await services.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const idOf = async (title: string, cookies = admin) => {
  const items = (await get(`/api/catalog/search?q=${encodeURIComponent(title)}`, cookies)).json().items as Array<{ id: number; title: string }>;
  return items.find((i) => i.title === title)!.id;
};

describe('rules', () => {
  it('recognises kids ratings', () => {
    for (const r of ['G', 'PG', 'TV-Y', 'TV-Y7', 'U', 'FSK 6', '6', '7+', 'tv-g']) expect(isKidsRating(r)).toBe(true);
    for (const r of ['R', 'PG-13', 'TV-14', 'TV-MA', '12', '16+', 'A', '', null]) expect(isKidsRating(r)).toBe(false);
  });

  it('decides completion and default versions', () => {
    expect(isComplete(2700, 3000)).toBe(true);
    expect(isComplete(2880, 3000)).toBe(true);
    expect(isComplete(1500, 3000)).toBe(false);
    expect(isComplete(100, 0)).toBe(false);
    const files = [
      { id: 1, videoCodec: 'hevc', height: 2160, missing: false },
      { id: 2, videoCodec: 'h264', height: 1080, missing: false },
      { id: 3, videoCodec: 'h264', height: 720, missing: true },
    ];
    expect(pickDefaultFile(files)?.id).toBe(2);
  });
});

describe('catalog', () => {
  it('builds the home screen with a playable hero', async () => {
    const res = await get('/api/catalog/home');
    expect(res.statusCode).toBe(200);
    const home = res.json();
    expect(home.rows.map((r: { id: string }) => r.id)).toEqual(['recent', 'movies', 'genre:Animation', 'genre:Family']);
    expect(home.hero).toMatchObject({ overview: expect.stringMatching(/^About /), target: { fileId: expect.any(Number) } });
    const card = home.rows.find((r: { id: string }) => r.id === 'recent').items[0];
    expect(card.poster).toMatch(/^\/api\/artwork\/item\/\d+\/poster\?v=[0-9a-f]{10}$/);
  });

  it('hides grown-up titles from kids profiles everywhere', async () => {
    const kidsHome = (await get('/api/catalog/home', kid)).json();
    const titles = new Set(kidsHome.rows.flatMap((r: { items: Array<{ title: string }> }) => r.items.map((i) => i.title)));
    expect([...titles].sort()).toEqual(['Cartoon Club', 'Toy Town']);

    const dark = await idOf('Dark Night');
    expect((await get(`/api/catalog/items/${dark}`, kid)).statusCode).toBe(404);
    expect((await get(`/api/catalog/search?q=Bale`, kid)).json().items).toEqual([]);
    const detail = (await get(`/api/catalog/items/${dark}`)).json().item;
    const play = await app.inject({ method: 'POST', url: `/api/files/${detail.versions[0].id}/playback`, cookies: kid, payload: {} });
    expect(play.statusCode).toBe(404);
    expect((await get(detail.poster, kid)).statusCode).toBe(404);
  });

  it('returns details with versions, cast, similar titles and the play target', async () => {
    const toy = (await get(`/api/catalog/items/${await idOf('Toy Town')}`)).json().item;
    expect(toy).toMatchObject({ kind: 'movie', title: 'Toy Town', resolution: '4K', hdr: 'HDR10', contentRating: 'G' });
    expect(toy.versions.map((v: { label: string }) => v.label).sort()).toEqual(['1080p · H.264', '4K · HEVC · HDR10']);
    expect(toy.target.fileId).toBe(toy.versions.find((v: { resolution: string }) => v.resolution === '1080p').id);
    expect(toy.cast[0]).toMatchObject({ name: 'Tom Hanks', photo: expect.stringMatching(/cast-0/) });
    expect(toy.similar.map((s: { title: string }) => s.title)).toEqual(['Local Art']);
  });

  it('browses, filters by genre and searches cast', async () => {
    const browse = (await get('/api/catalog/browse?kind=movie&sort=rating')).json();
    expect(browse.total).toBe(3);
    expect(browse.items[0].title).toBe('Dark Night');
    const crime = (await get('/api/catalog/browse?genre=crime')).json();
    expect(crime.items.map((i: { title: string }) => i.title)).toEqual(['Dark Night']);
    const genres = (await get('/api/catalog/genres?kind=movie')).json().genres;
    expect(genres[0]).toEqual({ name: 'Animation', count: 2 });
    expect((await get('/api/catalog/search?q=hanks')).json().items).toHaveLength(3);
    expect((await get('/api/catalog/search?q=100%25')).json().items).toEqual([]);
  });

  it('manages My List', async () => {
    const id = await idOf('Dark Night');
    expect((await app.inject({ method: 'PUT', url: `/api/catalog/my-list/${id}`, cookies: admin })).statusCode).toBe(204);
    expect((await get('/api/catalog/my-list')).json().items.map((i: { id: number }) => i.id)).toEqual([id]);
    expect((await get(`/api/catalog/items/${id}`)).json().item.inList).toBe(true);
    expect((await get('/api/catalog/home')).json().rows[0].id).toBe('my-list');
    await app.inject({ method: 'DELETE', url: `/api/catalog/my-list/${id}`, cookies: admin });
    expect((await get('/api/catalog/my-list')).json().items).toEqual([]);
  });
});

describe('progress', () => {
  it('resumes movies and drops them from Continue Watching once watched', async () => {
    const item = (await get(`/api/catalog/items/${await idOf('Dark Night')}`)).json().item;
    const fileId = item.versions[0].id;
    await app.inject({ method: 'PUT', url: `/api/progress/${fileId}`, cookies: admin, payload: { positionSeconds: 1500, durationSeconds: 3000 } });

    const row = (await get('/api/catalog/home')).json().rows.find((r: { id: string }) => r.id === 'continue');
    expect(row.items[0]).toMatchObject({ title: 'Dark Night', progress: 0.5, target: { fileId, positionSeconds: 1500, resume: true } });
    const ctx = (await get(`/api/catalog/files/${fileId}/context`)).json();
    expect(ctx).toMatchObject({ resumeSeconds: 1500, episode: null, next: null, item: { title: 'Dark Night' } });

    // sendBeacon-style POST with a text body.
    const beacon = await app.inject({
      method: 'POST',
      url: `/api/progress/${fileId}`,
      cookies: admin,
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ positionSeconds: 2950 }),
    });
    expect(beacon.json()).toEqual({ completed: true });
    expect((await get('/api/catalog/home')).json().rows.some((r: { id: string }) => r.id === 'continue')).toBe(false);
    expect((await get(`/api/catalog/items/${item.id}`)).json().item).toMatchObject({ watched: true, target: { resume: false } });
  });

  it('moves shows on to the next episode', async () => {
    const showId = await idOf('Cartoon Club');
    const show = (await get(`/api/catalog/items/${showId}`)).json().item;
    expect(show.seasons.map((s: { seasonNumber: number; episodeCount: number }) => [s.seasonNumber, s.episodeCount])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(show.target).toMatchObject({ episodeLabel: 'S1:E1', resume: false });

    const s1 = (await get(`/api/catalog/items/${showId}/seasons/1`)).json().episodes;
    expect(s1.map((e: { title: string }) => e.title)).toEqual(['Ep 1', 'Ep 2']);
    await app.inject({ method: 'PUT', url: `/api/progress/${s1[0].fileId}`, cookies: admin, payload: { positionSeconds: 2990 } });

    const ctx = (await get(`/api/catalog/files/${s1[0].fileId}/context`)).json();
    expect(ctx.next).toMatchObject({ episodeLabel: 'S1:E2', fileId: s1[1].fileId });

    const cont = (await get('/api/catalog/home')).json().rows.find((r: { id: string }) => r.id === 'continue');
    expect(cont.items[0]).toMatchObject({ title: 'Cartoon Club', progress: 0, target: { episodeLabel: 'S1:E2' } });

    await app.inject({ method: 'DELETE', url: `/api/catalog/continue/${showId}`, cookies: admin });
    expect((await get('/api/catalog/home')).json().rows.some((r: { id: string }) => r.id === 'continue')).toBe(false);

    await app.inject({ method: 'PUT', url: `/api/catalog/items/${showId}/watched`, cookies: admin, payload: { watched: true } });
    const after = (await get(`/api/catalog/items/${showId}`)).json().item;
    expect(after.watched).toBe(true);
    expect(after.seasons.every((s: { watchedCount: number; episodeCount: number }) => s.watchedCount === s.episodeCount)).toBe(true);

    // Progress is per profile.
    expect((await get(`/api/catalog/items/${showId}`, kid)).json().item.watched).toBe(false);
  });
});

describe('artwork', () => {
  it('caches remote images and protects SVG', async () => {
    const card = (await get(`/api/catalog/items/${await idOf('Toy Town')}`)).json().item;
    fetched.length = 0;
    const first = await get(card.poster);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['cache-control']).toContain('immutable');
    await get(card.poster);
    expect(fetched).toEqual(['https://img.test/Toy%20Town.png']);

    const logo = await get(card.logo);
    expect(logo.headers['content-type']).toBe('image/svg+xml');
    expect(logo.headers['content-security-policy']).toContain('sandbox');
  });

  it('serves local sidecar artwork from library folders only', async () => {
    const id = await idOf('Local Art');
    const item = (await get(`/api/catalog/items/${id}`)).json().item;
    const res = await get(item.poster);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('jpeg-bytes');

    const outside = path.join(root, 'secret.jpg');
    fs.writeFileSync(outside, 'secret');
    services.database.sqlite.prepare('UPDATE media_items SET poster = ? WHERE id = ?').run(outside, id);
    const blocked = await get((await get(`/api/catalog/items/${id}`)).json().item.poster);
    expect(blocked.statusCode).toBe(404);
  });
});

describe('folder browser', () => {
  it('lists drives/roots and sub-folders for admins only', async () => {
    const roots = (await get('/api/admin/fs')).json();
    expect(roots.path).toBeNull();
    expect(roots.entries.length).toBeGreaterThan(0);

    const movies = (await get(`/api/admin/fs?path=${encodeURIComponent(path.join(media, 'Movies', 'Toy Town (1995)'))}`)).json();
    expect(movies).toMatchObject({ videoCount: 2, entries: [], parent: path.join(media, 'Movies') });
    const listing = (await get(`/api/admin/fs?path=${encodeURIComponent(path.join(media, 'Movies'))}`)).json();
    expect(listing.entries.map((e: { name: string }) => e.name)).toEqual(['Dark Night (2008)', 'Local Art (2001)', 'Toy Town (1995)']);

    expect((await get('/api/admin/fs', kid)).statusCode).toBe(403);
    expect((await get('/api/admin/fs?path=relative/dir')).statusCode).toBe(400);
    expect((await get(`/api/admin/fs?path=${encodeURIComponent(path.join(media, 'nope'))}`)).statusCode).toBe(404);
  });
});
