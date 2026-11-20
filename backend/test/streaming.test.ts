import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { libraries, mediaFiles } from '../src/db/schema.js';
import { runProcess } from '../src/lib/process.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import { readKeyframes } from '../src/media/keyframes.js';
import { createServices, type Services } from '../src/services.js';
import { PLUGINS_DIR, silentLogger, tempDir, waitFor } from './helpers/harness.js';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0 && spawnSync(FFPROBE, ['-version']).status === 0;

let root: string;
let media: string;
let services: Services;
let app: FastifyInstance;
let admin: Record<string, string>;
const fileIds: Record<string, number> = {};

async function ffmpeg(args: string[]): Promise<void> {
  const { code, stderr } = await runProcess(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 120_000 });
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
}

/** Start time per stream type of an MPEG-TS segment. */
async function streamStarts(file: string): Promise<{ video?: number; audio?: number; codecs: string[] }> {
  const { stdout } = await runProcess(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time', '-of', 'json', file]);
  const streams = (JSON.parse(stdout.toString()) as { streams: Array<{ codec_type: string; codec_name: string; start_time: string }> })
    .streams;
  const start = (t: string) => {
    const s = streams.find((x) => x.codec_type === t);
    return s ? Number(s.start_time) : undefined;
  };
  return { video: start('video'), audio: start('audio'), codecs: streams.map((s) => s.codec_name) };
}

async function download(url: string, cookies: Record<string, string>, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const res = await app.inject({ method: 'GET', url, cookies });
  if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
  fs.writeFileSync(to, res.rawPayload);
  return res;
}

async function startPlayback(fileKey: string, body: Record<string, unknown> = {}, cookies = admin) {
  const res = await app.inject({ method: 'POST', url: `/api/files/${fileIds[fileKey]}/playback`, cookies, payload: body });
  return res;
}

describe.skipIf(!hasFfmpeg)('streaming with ffmpeg', () => {
  beforeAll(async () => {
    root = tempDir();
    media = path.join(root, 'media');
    for (const d of ['Direct (2020)', 'Remux (2021)', 'Transcode (2022)', 'Stream (2023)']) fs.mkdirSync(path.join(media, d), { recursive: true });
    const srt = path.join(root, 'subs.srt');
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nHello from Streamora\n');
    const lavfi = (seconds: number, rate = 24) => [
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${rate}:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    ];
    await Promise.all([
      ffmpeg([...lavfi(6, 25), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest',
        path.join(media, 'Direct (2020)', 'Direct (2020).mp4')]),
      // H.264 with B-frames and 2 s GOPs, AC3 audio and an embedded SubRip track: remuxed.
      ffmpeg([...lavfi(60), '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2',
        '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-c:s', 'srt',
        '-metadata:s:s:0', 'language=eng', path.join(media, 'Remux (2021)', 'Remux (2021).mkv')]),
      ffmpeg([...lavfi(10), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest',
        path.join(media, 'Transcode (2022)', 'Transcode (2022).mkv')]),
      ffmpeg([...lavfi(8), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-f', 'mpegts',
        path.join(media, 'Stream (2023)', 'Stream (2023).ts')]),
    ]);

    const pluginsDir = path.join(root, 'plugins');
    fs.cpSync(path.join(PLUGINS_DIR, 'subtitle-manager'), path.join(pluginsDir, 'subtitle-manager'), {
      recursive: true,
      filter: (src) => !/[\\/](test|node_modules)$/.test(src),
    });
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: path.join(root, 'data'),
      PLUGINS_DIR: pluginsDir,
      PLUGINS_HOT_RELOAD: 'false',
      SCAN_ON_STARTUP: 'false',
      SCAN_INTERVAL_MINUTES: '0',
      HW_ACCEL: 'none',
      MAX_TRANSCODE_SESSIONS: '2',
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
    });
    services = await createServices(config, silentLogger());
    app = await buildApp(services);
    await services.plugins.init();

    const owner = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Owner' } });
    admin = { [SESSION_COOKIE]: owner.cookies.find((c) => c.name === SESSION_COOKIE)!.value };

    const lib = services.db.insert(libraries).values({ name: 'Movies', type: 'movies', paths: [media], watch: false }).returning().get();
    services.scans.requestScan(lib.id);
    await services.scans.idle(lib.id);
    for (const f of services.db.select().from(mediaFiles).all()) fileIds[path.basename(path.dirname(f.path))] = f.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await services?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('probes the files during the scan', () => {
    const remux = services.db.select().from(mediaFiles).where(eq(mediaFiles.id, fileIds['Remux (2021)']!)).get()!;
    expect(remux).toMatchObject({ container: 'mkv', videoCodec: 'h264', audioCodec: 'ac3', width: 320, height: 240, resolution: 'SD' });
    expect(remux.durationSeconds).toBeCloseTo(60, 0);
    expect(remux.streams.map((s) => s.type)).toEqual(['video', 'audio', 'subtitle']);
    const hevc = services.db.select().from(mediaFiles).where(eq(mediaFiles.id, fileIds['Transcode (2022)']!)).get()!;
    expect(hevc.videoCodec).toBe('hevc');
  });

  it('reads keyframes from Matroska and MP4 indexes exactly like ffprobe', async () => {
    // MP4 with B-frames (composition offsets) and an edit list.
    const mp4 = path.join(root, 'keyframes.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=12', '-c:v', 'libx264', '-preset', 'veryfast',
      '-bf', '3', '-g', '30', '-keyint_min', '10', mp4]);
    const cases: Array<[string, string]> = [
      [path.join(media, 'Remux (2021)', 'Remux (2021).mkv'), 'mkv'],
      [mp4, 'mp4'],
    ];
    for (const [file, container] of cases) {
      const { stdout } = await runProcess(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]);
      const expected = stdout
        .toString()
        .split(/\r?\n/)
        .filter((l) => l.includes('K'))
        .map((l) => Math.round(Number(l.split(',')[0]) * 1000) / 1000)
        .sort((a, b) => a - b);
      expect(expected.length).toBeGreaterThan(2);
      expect(await readKeyframes(file, container)).toEqual(expected);
    }
  });

  it('direct-plays MP4 with byte ranges', async () => {
    const res = await startPlayback('Direct (2020)');
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan).toMatchObject({ method: 'direct', reasons: [], mimeType: 'video/mp4', sessionId: null });
    const size = fs.statSync(path.join(media, 'Direct (2020)', 'Direct (2020).mp4')).size;

    const partial = await app.inject({ method: 'GET', url: plan.url, cookies: admin, headers: { range: 'bytes=0-99' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-99/${size}`);
    expect(partial.headers['content-type']).toBe('video/mp4');
    expect(partial.rawPayload.length).toBe(100);

    const tail = await app.inject({ method: 'GET', url: plan.url, cookies: admin, headers: { range: 'bytes=-10' } });
    expect(tail.headers['content-range']).toBe(`bytes ${size - 10}-${size - 1}/${size}`);

    const head = await app.inject({ method: 'HEAD', url: plan.url, cookies: admin });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(size));
    expect(head.headers['accept-ranges']).toBe('bytes');

    const bad = await app.inject({ method: 'GET', url: plan.url, cookies: admin, headers: { range: `bytes=${size}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${size}`);

    const stale = await app.inject({ method: 'GET', url: plan.url, cookies: admin, headers: { range: 'bytes=0-9', 'if-range': '"old"' } });
    expect(stale.statusCode).toBe(200);

    const anon = await app.inject({ method: 'GET', url: plan.url });
    expect(anon.statusCode).toBe(401);
  });

  it('remuxes MKV to HLS with seamless segments across seeks', async () => {
    const ready: string[] = [];
    const unsubscribe = services.events.subscribe((e) => {
      if (e.type === 'transcode.ready') ready.push((e.data as { sessionId: string }).sessionId);
    });
    const res = await startPlayback('Remux (2021)');
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan.method).toBe('remux');
    expect(plan.reasons).toEqual(['container mkv is not supported by this browser', 'audio codec ac3 is not supported by this browser']);
    expect(plan.url).toBe(`/api/hls/${plan.sessionId}/master.m3u8`);

    const master = await app.inject({ method: 'GET', url: plan.url, cookies: admin });
    expect(master.headers['content-type']).toContain('mpegurl');
    expect(master.body).toContain('CODECS="avc1.64000D,mp4a.40.2"');
    expect(master.body).toContain('RESOLUTION=320x240');

    const index = await app.inject({ method: 'GET', url: `/api/hls/${plan.sessionId}/index.m3u8`, cookies: admin });
    const durations = [...index.body.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
    expect(durations).toHaveLength(15); // 2 s keyframes grouped into 4 s segments
    expect(durations.slice(0, -1).every((d) => d === 4)).toBe(true);
    expect(index.body).toContain('#EXT-X-ENDLIST');

    const dir = path.join(root, 'segments');
    fs.mkdirSync(dir, { recursive: true });
    const base = `/api/hls/${plan.sessionId}`;
    const seg0 = await download(`${base}/0.ts`, admin, path.join(dir, 'a0.ts'));
    expect(seg0.headers['content-type']).toBe('video/mp2t');
    const first = await streamStarts(path.join(dir, 'a0.ts'));
    expect(first.codecs).toEqual(['h264', 'aac']);

    // Seek far ahead (restart at 12), then back to 11 (another restart): every segment
    // must sit exactly on the plan, so segments from different ffmpeg runs line up.
    await download(`${base}/12.ts`, admin, path.join(dir, 'a12.ts'));
    await download(`${base}/11.ts`, admin, path.join(dir, 'a11.ts'));
    await download(`${base}/1.ts`, admin, path.join(dir, 'a1.ts'));
    const s1 = await streamStarts(path.join(dir, 'a1.ts'));
    const s11 = await streamStarts(path.join(dir, 'a11.ts'));
    const s12 = await streamStarts(path.join(dir, 'a12.ts'));
    const offset = first.video!; // muxer delay, identical for every run
    expect(s1.video! - offset).toBeCloseTo(4, 2);
    expect(s11.video! - offset).toBeCloseTo(44, 2);
    expect(s12.video! - offset).toBeCloseTo(48, 2);
    expect(Math.abs(s12.audio! - s12.video!)).toBeLessThan(0.1);

    await waitFor(() => ready.includes(plan.sessionId));
    unsubscribe();
  }, 60_000);

  it('transcodes HEVC to H.264 on a fixed grid', async () => {
    const res = await startPlayback('Transcode (2022)');
    const plan = res.json();
    expect(plan.method).toBe('transcode');
    expect(plan.reasons).toContain('video codec hevc is not supported by this browser');
    const master = await app.inject({ method: 'GET', url: plan.url, cookies: admin });
    expect(master.body).toContain('CODECS="avc1.640029,mp4a.40.2"');

    const dir = path.join(root, 'segments');
    const base = `/api/hls/${plan.sessionId}`;
    await download(`${base}/0.ts`, admin, path.join(dir, 't0.ts'));
    await download(`${base}/2.ts`, admin, path.join(dir, 't2.ts'));
    const s0 = await streamStarts(path.join(dir, 't0.ts'));
    const s2 = await streamStarts(path.join(dir, 't2.ts'));
    expect(s0.codecs).toEqual(['h264', 'aac']);
    expect(s2.video! - s0.video!).toBeCloseTo(8, 2);
  }, 60_000);

  it('transcodes H.264 in containers without a keyframe index', async () => {
    const plan = (await startPlayback('Stream (2023)')).json();
    expect(plan.method).toBe('transcode');
    expect(plan.reasons).toContain('no keyframe index for stream copy');
  });

  it('converts embedded subtitles to WebVTT', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/files/${fileIds['Remux (2021)']}/subtitles`, cookies: admin });
    const [track] = list.json().subtitles;
    expect(track).toMatchObject({ source: 'embedded', language: 'eng', codec: 'subrip', renderable: true });
    const vtt = await app.inject({ method: 'GET', url: track.url, cookies: admin });
    expect(vtt.statusCode).toBe(200);
    expect(vtt.headers['content-type']).toContain('text/vtt');
    expect(vtt.body).toMatch(/^WEBVTT/);
    expect(vtt.body).toContain('Hello from Streamora');
  });

  it('keeps sessions private, enforces the transcode limit and cleans up', async () => {
    const createGuest = await app.inject({ method: 'POST', url: '/api/profiles', cookies: admin, payload: { name: 'Guest' } });
    const guestId = createGuest.json().profile.id as number;
    const signIn = await app.inject({ method: 'POST', url: `/api/profiles/${guestId}/session`, payload: {} });
    const guest = { [SESSION_COOKIE]: signIn.cookies.find((c) => c.name === SESSION_COOKIE)!.value };

    const listed = await app.inject({ method: 'GET', url: '/api/admin/transcodes', cookies: admin });
    const sessions = listed.json().sessions as Array<{ id: string; mode: string; fileId: number }>;
    expect(listed.json().encoder).toBe('libx264');
    const transcodes = sessions.filter((s) => s.mode === 'transcode');
    expect(transcodes).toHaveLength(2);

    // Someone else's session is invisible.
    const peek = await app.inject({ method: 'GET', url: `/api/hls/${transcodes[0]!.id}/master.m3u8`, cookies: guest });
    expect(peek.statusCode).toBe(404);

    // Two fresh transcodes are running: a third one is refused rather than killing them.
    const refused = await startPlayback('Transcode (2022)', {}, guest);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error).toBe('TRANSCODE_LIMIT');

    // Restarting the same file replaces the profile's own session instead.
    const again = await startPlayback('Transcode (2022)');
    expect(again.statusCode).toBe(200);
    expect(services.transcoder.get(transcodes.find((t) => t.fileId === fileIds['Transcode (2022)'])!.id)).toBeUndefined();

    const sid = again.json().sessionId as string;
    const sessionDir = path.join(services.config.media.transcodeDir, sid);
    await app.inject({ method: 'GET', url: `/api/hls/${sid}/0.ts`, cookies: admin });
    expect(fs.existsSync(sessionDir)).toBe(true);
    const del = await app.inject({ method: 'DELETE', url: `/api/hls/${sid}`, cookies: admin });
    expect(del.statusCode).toBe(204);
    expect(fs.existsSync(sessionDir)).toBe(false);
    const gone = await app.inject({ method: 'GET', url: `/api/hls/${sid}/index.m3u8`, cookies: admin });
    expect(gone.statusCode).toBe(404);
  }, 60_000);
});
