import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaFileInfo, MediaStreamInfo, SubtitleFileContext } from '@streamora/plugin-sdk';
import { callOptions, loadTestPlugin, tempDir, writeFiles, type TestPlugin } from '../../../backend/test/helpers/harness.js';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

const SRT = '1\n00:00:00,500 --> 00:00:01,500\nHello from SRT\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond <i>cue</i>\n';
const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,こんにちは
`;

let root: string;
let plugin: TestPlugin;
const p = (...parts: string[]) => path.join(root, ...parts);

beforeAll(async () => {
  root = tempDir('streamora-subs-');
  writeFiles(root, {
    'Movies/Heat (1995)/Heat (1995).mkv': '',
    'Movies/Heat (1995)/Heat (1995).en.srt': SRT,
    'Movies/Heat (1995)/Heat (1995).fr.forced.ass': ASS,
    'Movies/Heat (1995)/Subs/Spanish.srt': SRT,
    'Movies/Heat (1995)/notes.txt': 'not a subtitle',
    'Shows/Show/Season 1/Show S01E01.mkv': '',
    'Shows/Show/Season 1/Show S01E02.mkv': '',
    'Shows/Show/Season 1/Show S01E01.en.srt': SRT,
    'Shows/Show/Season 1/English.srt': SRT, // ambiguous: two videos share this folder
    'Shows/Show/Season 1/Subs/Show S01E01/2_English.srt': SRT,
  });
  plugin = await loadTestPlugin(PLUGIN_DIR, { libraryRoots: [p('Movies'), p('Shows')], settings: { preExtract: true, preferredLanguages: [] } });
});

afterAll(() => {
  plugin.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const fileContext = (file: string, siblings: string[], streams: MediaStreamInfo[] = []): SubtitleFileContext => ({
  path: file,
  streams,
  siblingVideoPaths: siblings,
});

describe('subtitle-manager: discovery', () => {
  it('finds sidecar files next to a movie and in Subs/', async () => {
    const movie = p('Movies', 'Heat (1995)', 'Heat (1995).mkv');
    const tracks = await plugin.instance.subtitles!.discover!(fileContext(movie, [movie], [
      { index: 0, type: 'video', codec: 'h264' },
      { index: 2, type: 'subtitle', codec: 'subrip', language: 'ger', title: 'German', default: true },
      { index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' },
    ]), callOptions());

    const summary = tracks.map((t) => [t.source, t.streamIndex ?? path.basename(t.path!), t.language, t.forced, t.renderable]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ['embedded', 2, 'ger', false, true],
        ['embedded', 3, 'eng', false, false],
        ['sidecar', 'Heat (1995).en.srt', 'eng', false, true],
        ['sidecar', 'Heat (1995).fr.forced.ass', 'fre', true, true],
        ['sidecar', 'Spanish.srt', 'spa', false, true],
      ]),
    );
    expect(tracks).toHaveLength(5);
  });

  it('only claims loose files when the video has its folder to itself', async () => {
    const e1 = p('Shows', 'Show', 'Season 1', 'Show S01E01.mkv');
    const e2 = p('Shows', 'Show', 'Season 1', 'Show S01E02.mkv');
    const tracks = await plugin.instance.subtitles!.discover!(fileContext(e1, [e1, e2]), callOptions());
    expect(tracks.map((t) => path.basename(t.path!)).sort()).toEqual(['2_English.srt', 'Show S01E01.en.srt']);
  });
});

describe('subtitle-manager: rendering', () => {
  it('converts sidecar SRT and ASS files to WebVTT', async () => {
    const movie: MediaFileInfo = { path: p('Movies', 'Heat (1995)', 'Heat (1995).mkv'), streams: [] };
    const srt = await plugin.instance.subtitles!.render!(
      { source: 'sidecar', path: p('Movies', 'Heat (1995)', 'Heat (1995).en.srt'), codec: 'srt' },
      movie,
      callOptions(),
    );
    expect(srt).toBe('WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nHello from SRT\n\n00:00:02.000 --> 00:00:03.000\nSecond <i>cue</i>\n');

    const ass = await plugin.instance.subtitles!.render!(
      { source: 'sidecar', path: p('Movies', 'Heat (1995)', 'Heat (1995).fr.forced.ass'), codec: 'ass' },
      movie,
      callOptions(),
    );
    expect(ass).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nこんにちは\n');
  });

  it('declines bitmap subtitles', async () => {
    const result = await plugin.instance.subtitles!.render!(
      { source: 'embedded', streamIndex: 3, codec: 'hdmv_pgs_subtitle', renderable: false },
      { path: p('Movies', 'Heat (1995)', 'Heat (1995).mkv'), streams: [] },
      callOptions(),
    );
    expect(result).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)('subtitle-manager: embedded tracks (ffmpeg)', () => {
  let mkv: string;
  let file: MediaFileInfo;

  beforeAll(async () => {
    writeFiles(root, { 'Movies/Embedded/a.srt': SRT, 'Movies/Embedded/b.ass': ASS });
    mkv = p('Movies', 'Embedded', 'Embedded (2020).mkv');
    const made = spawnSync(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=4',
        '-i', p('Movies', 'Embedded', 'a.srt'),
        '-i', p('Movies', 'Embedded', 'b.ass'),
        '-map', '0:v', '-map', '1:s', '-map', '2:s',
        '-c:v', 'mpeg4', '-c:s:0', 'srt', '-c:s:1', 'ass',
        '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=jpn',
        mkv,
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(`ffmpeg could not build the fixture: ${made.stderr}`);

    const probe = await plugin.ctx.ffmpeg.probe(mkv);
    file = {
      path: mkv,
      sizeBytes: fs.statSync(mkv).size,
      streams: (probe.streams ?? []).map((s) => ({
        index: s.index,
        type: s.codec_type as MediaStreamInfo['type'],
        codec: String(s.codec_name),
        language: s.tags?.language,
      })),
    };
  });

  it('extracts an embedded SRT track via ffmpeg and caches it', async () => {
    const vtt = await plugin.instance.subtitles!.render!(
      { source: 'embedded', streamIndex: 1, codec: 'subrip' },
      file,
      callOptions(),
    );
    expect(vtt).toMatch(/^WEBVTT/);
    // ffmpeg writes the (valid) short MM:SS.mmm form when hours are zero.
    expect(vtt).toContain('00:00.500 --> 00:01.500');
    expect(vtt).toContain('Hello from SRT');
    expect(await plugin.ctx.cache.get(`embedded:${mkv}:${file.sizeBytes}:1`)).toBe(vtt);
  });

  it('pre-extracts every text track in one pass after a scan', async () => {
    await plugin.instance.postScan!.onScanComplete(
      {
        library: { id: 1, name: 'Movies', type: 'movies', paths: [p('Movies')] },
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        added: [{ id: 1, kind: 'movie', title: 'Embedded', externalIds: {}, files: [file] }],
        updated: [],
        removed: [],
      },
      callOptions(),
    );
    const jpn = await plugin.ctx.cache.get<string>(`embedded:${mkv}:${file.sizeBytes}:2`);
    expect(jpn).toContain('こんにちは');
    // Scratch files are cleaned up.
    expect(fs.readdirSync(plugin.dataDir).filter((n) => n.startsWith('extract-'))).toEqual([]);
  });
});
