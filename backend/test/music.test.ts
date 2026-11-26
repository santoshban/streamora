import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { libraries, type Library } from '../src/db/schema.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import type { MediaProbe } from '../src/media/probe.js';
import { parseLrc } from '../src/music/lyrics.js';
import { mimeFor } from '../src/music/service.js';
import { parseAlbumFolder, parseTrackFileName, readTrackTags } from '../src/music/tags.js';
import { createServices, type Services } from '../src/services.js';
import { silentLogger, tempDir, writeFiles } from './helpers/harness.js';

// ── parsing ──────────────────────────────────────────────────────────────────

describe('music tags', () => {
  const root = path.resolve('/music');
  const at = (rel: string) => path.join(root, rel);

  it('prefers tags and splits credits', () => {
    const t = readTrackTags(
      {
        title: 'Glass Rivers',
        artist: 'Aurora Fields feat. Kite Theory',
        album: 'Northern Lights',
        album_artist: 'Aurora Fields',
        track: '2/8',
        disc: '1/2',
        date: '2021-03-04',
        genre: 'Synthpop;Electronic',
      },
      at('whatever/x.mp3'),
      root,
    );
    expect(t).toMatchObject({
      title: 'Glass Rivers',
      artist: 'Aurora Fields feat. Kite Theory',
      primaryArtist: 'Aurora Fields',
      albumArtist: 'Aurora Fields',
      album: 'Northern Lights',
      trackNumber: 2,
      discNumber: 1,
      year: 2021,
      genres: ['Synthpop', 'Electronic'],
    });
  });

  it('falls back to Artist/Album (Year)/NN - Title folders', () => {
    const t = readTrackTags({}, at('Neon Harbor/Coastline (2019)/CD2/03 - Salt Air.flac'), root);
    expect(t).toMatchObject({ title: 'Salt Air', artist: 'Neon Harbor', album: 'Coastline', year: 2019, trackNumber: 3, discNumber: 2 });
  });

  it('reads "Artist - Album" folders and loose singles', () => {
    expect(readTrackTags({}, at('Neon Harbor - Coastline/01. Tidal.mp3'), root)).toMatchObject({
      title: 'Tidal',
      artist: 'Neon Harbor',
      album: 'Coastline',
      trackNumber: 1,
    });
    expect(readTrackTags({}, at('Velvet Static - Old Format.wma'), root)).toMatchObject({
      title: 'Old Format',
      artist: 'Velvet Static',
      album: 'Old Format',
    });
  });

  it('does not take a band name for a track number', () => {
    expect(parseTrackFileName('50 Cent - In Da Club')).toMatchObject({ track: undefined, artist: '50 Cent', title: 'In Da Club' });
    expect(parseTrackFileName('05 Song')).toMatchObject({ track: 5, title: 'Song' });
    expect(parseTrackFileName('1-03 Song')).toMatchObject({ disc: 1, track: 3, title: 'Song' });
    expect(parseAlbumFolder('[1969] Abbey Road')).toEqual({ album: 'Abbey Road', year: 1969 });
  });

  it('files compilations under Various Artists', () => {
    expect(readTrackTags({ title: 'A', artist: 'X', album: 'Hits', compilation: '1' }, at('Hits/a.mp3'), root).albumArtist).toBe('Various Artists');
  });
});

describe('lyrics', () => {
  it('parses LRC with several stamps, offsets and word stamps', () => {
    const lrc = parseLrc('[ti:Song]\n[offset:500]\n[00:01.00][00:20.00]Chorus <00:01.50>line\n[00:10.50]Verse\nnot stamped');
    expect(lrc.synced).toEqual([
      { time: 0.5, text: 'Chorus line' },
      { time: 10, text: 'Verse' },
      { time: 19.5, text: 'Chorus line' },
    ]);
    expect(lrc.plain).toBe('Chorus line\nVerse\nnot stamped');
  });

  it('treats text without stamps as plain lyrics', () => {
    expect(parseLrc('Just words\nMore words')).toEqual({ synced: null, plain: 'Just words\nMore words' });
  });
});

describe('mime types', () => {
  it('gives browsers what they need for canPlayType', () => {
    expect(mimeFor('mp3', 'mp3')).toBe('audio/mpeg');
    expect(mimeFor('aac', 'mp4')).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(mimeFor('opus', 'ogg')).toBe('audio/ogg; codecs="opus"');
    expect(mimeFor('alac', 'mp4')).toBe('audio/mp4; codecs="alac"');
    expect(mimeFor('wmav2', 'asf')).toBeNull();
  });
});

// ── scanning + API ───────────────────────────────────────────────────────────

let root: string;
let media: string;
let services: Services;
let app: FastifyInstance;

/** Test "audio" files hold their tags as JSON; `corrupt` files fail like ffprobe would. */
const fakeProbe = async (file: string): Promise<MediaProbe> => {
  if (file.includes('corrupt')) throw new Error('Invalid data found when processing input');
  const text = fs.readFileSync(file, 'utf8');
  const tags = text.startsWith('{') ? (JSON.parse(text) as Record<string, string>) : {};
  return {
    container: 'mp3',
    durationSeconds: Number(tags.duration ?? 200),
    bitrate: 320_000,
    startTimeSeconds: 0,
    videoCodec: null,
    videoProfile: null,
    width: null,
    height: null,
    frameRate: null,
    bitDepth: null,
    resolution: null,
    hdr: null,
    audioCodec: 'mp3',
    audioChannels: 2,
    streams: [{ index: 0, type: 'audio', codec: 'mp3', channels: 2, sampleRate: 44_100, default: true }],
    tags,
  };
};

const tags = (t: Record<string, string | number>) => JSON.stringify(t);

beforeAll(async () => {
  root = tempDir();
  media = path.join(root, 'music');
  writeFiles(media, {
    'Aurora Fields/Northern Lights (2021)/01 - Midnight Drive.mp3': tags({ title: 'Midnight Drive', artist: 'Aurora Fields', album: 'Northern Lights', track: 1, date: 2021, genre: 'Synthpop' }),
    'Aurora Fields/Northern Lights (2021)/02 - Glass Rivers.mp3': tags({ title: 'Glass Rivers', artist: 'Aurora Fields feat. Kite Theory', album: 'Northern Lights', album_artist: 'Aurora Fields', track: 2, date: 2021, genre: 'Synthpop' }),
    'Aurora Fields/Northern Lights (2021)/cover.jpg': 'jpeg',
    'Aurora Fields/folder.jpg': 'artist photo',
    'Aurora Fields/Northern Lights (2021)/02 - Glass Rivers.lrc': '[00:01.00]First line\n[00:04.00]Second line',
    'Summer Hits/01 Sunburn.mp3': tags({ title: 'Sunburn', artist: 'Kite Theory', album: 'Summer Hits', track: 1, genre: 'Pop' }),
    'Summer Hits/02 Lemonade.mp3': tags({ title: 'Lemonade', artist: 'Velvet Static', album: 'Summer Hits', track: 2, genre: 'Pop' }),
    'Neon Harbor - Coastline (2019)/01 - Salt Air.mp3': 'no tags',
    'Broken/corrupt.mp3': 'garbage',
    'notes.txt': 'not music',
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DIR: path.join(root, 'data'),
    PLUGINS_DIR: path.join(root, 'plugins'),
    PLUGINS_HOT_RELOAD: 'false',
    SCAN_ON_STARTUP: 'false',
    SCAN_INTERVAL_MINUTES: '0',
  });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  services = await createServices(config, silentLogger(), { ffmpeg: { ffmpeg: null, ffprobe: null }, probe: fakeProbe });
  app = await buildApp(services);
  await services.plugins.init();
});

afterAll(async () => {
  await app.close();
  await services.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const sessionOf = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

describe('music library', () => {
  let session = '';
  let other = '';
  let lib: Library;
  const get = async (url: string, as = session) => {
    const res = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: as } });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return res.json();
  };
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, as = session) =>
    app.inject({ method, url, payload: payload as object, cookies: { [SESSION_COOKIE]: as } });

  const scan = async () => {
    services.scans.requestScan(lib.id);
    await services.scans.idle(lib.id);
    return services.scans.status(lib.id).last!;
  };

  it('scans tracks into artists and albums', async () => {
    session = sessionOf(await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Owner' } }));
    const created = await send('POST', '/api/profiles', { name: 'Guest' });
    other = sessionOf(await app.inject({ method: 'POST', url: `/api/profiles/${created.json().profile.id}/session`, payload: {} }));
    lib = services.db.insert(libraries).values({ name: 'Music', type: 'music', paths: [media], watch: false }).returning().get();

    const last = await scan();
    expect(last.files).toMatchObject({ added: 6 });
    expect(last.errors).toEqual([expect.stringContaining('corrupt.mp3')]);

    const { albums } = await get('/api/music/albums?sort=title');
    expect(albums.map((a: { title: string; artist: { name: string } }) => `${a.title} / ${a.artist.name}`)).toEqual([
      'Coastline / Neon Harbor',
      'Northern Lights / Aurora Fields',
      'Summer Hits / Various Artists',
    ]);
    const northern = albums.find((a: { title: string }) => a.title === 'Northern Lights');
    expect(northern).toMatchObject({ year: 2021, trackCount: 2, genres: ['Synthpop'], art: expect.stringMatching(/^\/api\/music\/art\/album\/\d+\?v=/) });

    const { libraries: list } = await get('/api/libraries');
    expect(list[0].counts).toMatchObject({ albums: 3, tracks: 5 });
  });

  it('serves album and artist pages, art and lyrics', async () => {
    const { artists } = await get('/api/music/artists');
    const aurora = artists.find((a: { name: string }) => a.name === 'Aurora Fields');
    expect(aurora.art).toMatch(/^\/api\/music\/art\/artist\//);

    const page = await get(`/api/music/artists/${aurora.id}`);
    expect(page.topSongs.map((t: { title: string }) => t.title).sort()).toEqual(['Glass Rivers', 'Midnight Drive']);

    const { albums } = await get('/api/music/albums?sort=title');
    const album = await get(`/api/music/albums/${albums[1].id}`);
    expect(album.tracks.map((t: { title: string; artistName: string }) => `${t.title} — ${t.artistName}`)).toEqual([
      'Midnight Drive — Aurora Fields',
      'Glass Rivers — Aurora Fields feat. Kite Theory',
    ]);

    // Without ffmpeg, folder images are served as they are.
    const art = await app.inject({ method: 'GET', url: albums[1].art, cookies: { [SESSION_COOKIE]: session } });
    expect(art.statusCode).toBe(200);
    expect(art.body).toBe('jpeg');

    const glass = album.tracks[1];
    expect((await get(`/api/music/tracks/${glass.id}/lyrics`)).lyrics).toMatchObject({
      source: 'lrc',
      synced: [{ time: 1, text: 'First line' }, { time: 4, text: 'Second line' }],
    });

    const stream = await app.inject({ method: 'GET', url: `/api/music/tracks/${glass.id}/stream`, headers: { range: 'bytes=0-1' }, cookies: { [SESSION_COOKIE]: session } });
    expect(stream.statusCode).toBe(206);
    expect(stream.headers['content-type']).toBe('audio/mpeg');
  });

  it('keeps likes, plays and playlists per profile', async () => {
    const { tracks } = await get('/api/music/tracks?sort=title');
    const [first, second] = tracks;
    expect((await send('PUT', `/api/music/tracks/${first.id}/like`, { liked: true })).statusCode).toBe(204);
    expect((await send('POST', `/api/music/tracks/${second.id}/played`, {})).statusCode).toBe(204);

    expect((await get('/api/music/likes')).tracks.map((t: { id: number }) => t.id)).toEqual([first.id]);
    expect((await get('/api/music/likes', other)).tracks).toEqual([]);
    const home = await get('/api/music/home');
    expect(home.listenAgain[0]).toMatchObject({ type: 'album' });
    expect(home.quickPicks.find((t: { id: number }) => t.id === first.id)?.liked).toBe(true);

    const created = await send('POST', '/api/music/playlists', { name: 'Road trip', trackIds: [first.id, second.id] });
    expect(created.statusCode).toBe(201);
    const id = created.json().playlist.id;
    expect((await send('POST', `/api/music/playlists/${id}/tracks`, { trackIds: [first.id] })).json()).toEqual({ added: 1, duplicates: 1 });
    let list = await get(`/api/music/playlists/${id}`);
    expect(list.entries).toHaveLength(3);
    const order = list.entries.map((e: { entryId: number }) => e.entryId).reverse();
    expect((await send('PUT', `/api/music/playlists/${id}/order`, { entryIds: order })).statusCode).toBe(204);
    expect((await send('DELETE', `/api/music/playlists/${id}/entries/${order[0]}`)).statusCode).toBe(204);
    list = await get(`/api/music/playlists/${id}`);
    expect(list.entries.map((e: { track: { id: number } }) => e.track.id)).toEqual([second.id, first.id]);

    // Other profiles can't see or change it.
    expect((await send('DELETE', `/api/music/playlists/${id}`, undefined, other)).statusCode).toBe(404);
    expect((await get('/api/music/playlists', other)).playlists).toEqual([]);
  });

  it('searches, suggests and builds radio stations', async () => {
    const res = await get('/api/music/search?q=aurora');
    expect(res.top).toMatchObject({ type: 'artist', artist: { name: 'Aurora Fields' } });
    expect(res.songs.length).toBeGreaterThan(0);
    expect((await get('/api/music/suggest?q=sun')).suggestions).toContain('Sunburn');

    const { tracks } = await get('/api/music/tracks?sort=title');
    const radio = await get(`/api/music/radio?track=${tracks[0].id}&limit=10`);
    expect(radio.tracks[0].id).toBe(tracks[0].id);
    expect(new Set(radio.tracks.map((t: { id: number }) => t.id)).size).toBe(radio.tracks.length);
    const excluded = await get(`/api/music/radio?track=${tracks[0].id}&exclude=${tracks[0].id}`);
    expect(excluded.tracks.map((t: { id: number }) => t.id)).not.toContain(tracks[0].id);
  });

  it('removes tracks, albums and artists whose files are gone', async () => {
    fs.rmSync(path.join(media, 'Summer Hits'), { recursive: true });
    const last = await scan();
    expect(last).toMatchObject({ removed: 1, files: { removed: 2 } });
    const { artists } = await get('/api/music/artists');
    // Kite Theory only had a track on the deleted compilation ("feat." credits don't count).
    expect(artists.map((a: { name: string }) => a.name).sort()).toEqual(['Aurora Fields', 'Neon Harbor']);
  });
});
